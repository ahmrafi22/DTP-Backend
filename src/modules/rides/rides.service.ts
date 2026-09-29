import { firstOrNull, query, rowsAffected, withTransaction } from "../../shared/db.js";
import type { DbClient } from "../../shared/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import {
  edgeByLegId,
  getEdge,
  getRoute,
  legsBetween,
  priceLegs,
  shortestPath,
} from "../../graph/index.js";
import type { Edge, RidersPerLeg } from "../../graph/index.js";
import { liveRideFor } from "../map/map.routes.js";
import type {
  Fare,
  FareLegRow,
  FareLine,
  JoinPreview,
  RideEventRow,
  RideRequestRow,
  RideRequestWithNameRow,
  RideRow,
  RideStatus,
  Role,
  SerializedCoRider,
  SerializedRequest,
  SerializedRide,
  UserRow,
  VehicleRow,
  VehicleWithDriverRow,
  EarningsRow,
} from "../../shared/types.js";
import {
  ACTIVE_RIDE_STATUSES,
  WAIT_AND_SAVE_EXTRA_PCT,
  WAIT_AND_SAVE_SECONDS,
  ALLOWED_NEXT,
  isCancellable,
} from "./rides.constants.js";

/**
 * The pool engine (PRD §6, §10, §11).
 *
 * - Trips resolve to ordered legs on a predefined corridor (or a shortest
 *   path when no single corridor connects the stops).
 * - Fare per passenger = base + sum(leg prices) − shared-leg discounts.
 *   Discounts: 1 rider 0%, 2 riders 20%, 3 riders 30% (PRD §6).
 * - Seats are claimed with one atomic conditional UPDATE inside a
 *   transaction, with `rides.seats_taken <= capacity` as a DB backstop.
 * - Lifecycle transitions follow PRD §4 exactly; anything else is rejected.
 */


/** Array element at `index`, throwing rather than yielding undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`Index ${index} is out of range (length ${items.length})`);
  }
  return item;
}

/** A trip resolved to concrete legs on the graph. */
export interface ResolvedTrip {
  /** null when the trip spans more than one corridor. */
  routeId: string | null;
  legs: Edge[];
  stopIds: string[];
}

/** One entry in the ride's audit trail. */
export interface SerializedEvent {
  event: string;
  actorId: string | null;
  at: Date;
  meta: Record<string, unknown> | null;
}

export interface PoolGroup {
  requestIds: string[];
  seats: number;
  requests: SerializedRequest[];
}

export interface DriverState {
  online: boolean;
  vehicle: { id: string; name: string; capacity: number };
  activeTrip: (SerializedRide & { requests: SerializedRequest[] }) | null;
  pendingGroups: Array<PoolGroup & { fits: boolean }>;
  earnings: { totalPaisa: number; completedTrips: number };
}

export interface DriverTrip extends SerializedRide {
  requests: SerializedRequest[];
  events: SerializedEvent[];
}

/**
 * The passenger's live view. `trip`, `vehicle` and `coRiders` are only present
 * once the request has actually been matched to a ride — the keys are absent,
 * not null, until then.
 */
export interface ActivePassengerView {
  request: SerializedRequest;
  trip?: SerializedRide | null;
  vehicle?: { id: string; name: string; capacity: number; driverName: string } | null;
  coRiders?: SerializedCoRider[];
}

// ---------- trip resolution ----------

/** Resolve pickup/drop (+ optional corridor) to ordered legs and stops. */
export function resolveTrip({
  pickupStopId,
  dropStopId,
  routeId,
}: {
  pickupStopId: string;
  dropStopId: string;
  routeId?: string | null;
}): ResolvedTrip {
  if (pickupStopId === dropStopId) throw badRequest("Pickup and destination must differ");

  if (routeId) {
    const legs = legsBetween(routeId, pickupStopId, dropStopId);
    const route = getRoute(routeId);
    if (!legs || !route) throw badRequest("Stops are not on that corridor in travel order");
    const i = route.stops.indexOf(pickupStopId);
    const j = route.stops.indexOf(dropStopId);
    return {
      routeId,
      legs,
      stopIds: route.stops.slice(Math.min(i, j), Math.max(i, j) + 1),
    };
  }

  // No corridor given: the single fastest path through the graph.
  const path = shortestPath(pickupStopId, dropStopId, "durationMin");
  if (!path) throw badRequest("No route connects these stops in the demo graph");
  return { routeId: null, legs: path.legs, stopIds: path.stops };
}

// ---------- fares ----------

function fareFromRow(row: RideRequestRow, lines: FareLine[]): Fare {
  return {
    baseFare: row.base_fare_paisa,
    distanceCharge: row.distance_charge_paisa,
    poolDiscount: row.pool_discount_paisa,
    total: row.total_fare_paisa,
    lines,
  };
}

const FARE_LINE_COLUMNS = `
  leg_no, leg_id, from_stop, to_stop, riders_on_leg, discount_pct, price_paisa, paid_paisa`;

/**
 * The stored per-leg breakdown for one request. Reads through `runner` when
 * given (inside a transaction) and through the pool otherwise.
 */
export async function fareLinesForRequest(
  requestId: string,
  runner: DbClient | null = null,
): Promise<FareLine[]> {
  const sql = `SELECT ${FARE_LINE_COLUMNS} FROM fare_legs WHERE request_id = $1 ORDER BY leg_no`;
  const res = runner
    ? await runner.query<FareLegRow>(sql, [requestId])
    : await query<FareLegRow>(sql, [requestId]);

  return res.rows.map((r) => ({
    edgeId: r.leg_id,
    from: r.from_stop,
    to: r.to_stop,
    riders: r.riders_on_leg,
    discountPct: r.discount_pct,
    pricePaisa: r.price_paisa,
    paidPaisa: r.paid_paisa,
  }));
}

export function serializeRequest(
  row: RideRequestRow | RideRequestWithNameRow,
  lines: FareLine[] = [],
): SerializedRequest {
  return {
    id: row.id,
    passengerId: row.passenger_id,
    rideId: row.ride_id,
    pickupStopId: row.pickup_stop,
    dropStopId: row.drop_stop,
    routeId: row.route_id,
    legIds: row.leg_ids,
    stopIds: row.stop_ids,
    seats: row.seats,
    status: row.status,
    rating: row.rating,
    cancelReason: row.cancel_reason,
    waitAndSave: row.wait_and_save,
    waitDeadline: row.wait_deadline,
    waitDecided: row.wait_decided_at !== null,
    fare: fareFromRow(row, lines),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...("passenger_name" in row ? { passengerName: row.passenger_name } : {}),
  };
}

export function serializeRide(row: RideRow): SerializedRide {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    status: row.status,
    seatsTaken: row.seats_taken,
    capacity: row.capacity,
    stopIds: row.stop_ids ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The path a ride is driving: the ride's own path, else its primary rider's. */
export async function ridePath(ride: RideRow): Promise<string[]> {
  if (ride.stop_ids && ride.stop_ids.length >= 2) return ride.stop_ids;
  const members = await serializeRideMembers(ride.id);
  const primary = members[0];
  return primary?.stopIds ?? [];
}

/**
 * Regenerate fare_legs for every member of a ride: count riders per leg
 * across all members, apply the discount tiers, persist the breakdown and
 * the request totals. Called whenever membership changes (accept, join,
 * cancel) — completed members are left alone.
 */
export async function recomputeRideFares(client: DbClient, rideId: string): Promise<number> {
  const { rows } = await client.query<RideRequestRow>(
    `SELECT * FROM ride_requests
     WHERE ride_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')
     ORDER BY created_at`,
    [rideId],
  );

  const ridersPerLeg: RidersPerLeg = {};
  for (const req of rows) {
    for (const legId of req.leg_ids) {
      ridersPerLeg[legId] = (ridersPerLeg[legId] ?? 0) + 1;
    }
  }

  for (const req of rows) {
    const legs = req.leg_ids.map(edgeByLegId);
    const fare = priceLegs(legs, ridersPerLeg);

    await client.query("DELETE FROM fare_legs WHERE request_id = $1", [req.id]);
    for (let i = 0; i < fare.lines.length; i += 1) {
      const line = at(fare.lines, i);
      await client.query(
        `INSERT INTO fare_legs
          (request_id, leg_no, leg_id, from_stop, to_stop, riders_on_leg, discount_pct, price_paisa, paid_paisa)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          req.id,
          i,
          line.edgeId,
          line.from,
          line.to,
          line.riders,
          line.discountPct,
          line.pricePaisa,
          line.paidPaisa,
        ],
      );
    }
    await client.query(
      `UPDATE ride_requests
       SET base_fare_paisa = $2, distance_charge_paisa = $3, pool_discount_paisa = $4,
           total_fare_paisa = $5, updated_at = now()
       WHERE id = $1`,
      [req.id, fare.baseFare, fare.distanceCharge, fare.poolDiscount, fare.total],
    );
  }

  return rows.length;
}

// ---------- events ----------

export interface RideEventInput {
  rideId?: string | null;
  requestId?: string | null;
  event: string;
  actorId?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function logEvent(client: DbClient, input: RideEventInput): Promise<void> {
  await client.query(
    `INSERT INTO ride_events (ride_id, request_id, event, actor_id, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.rideId ?? null,
      input.requestId ?? null,
      input.event,
      input.actorId ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
    ],
  );
}

export async function eventsForRide(rideId: string): Promise<SerializedEvent[]> {
  const { rows } = await query<RideEventRow>(
    "SELECT event, actor_id, at, meta FROM ride_events WHERE ride_id = $1 ORDER BY at",
    [rideId],
  );
  return rows.map((r) => ({ event: r.event, actorId: r.actor_id, at: r.at, meta: r.meta }));
}

// ---------- reads ----------

export async function getRequestById(id: string): Promise<RideRequestRow | null> {
  return firstOrNull(await query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [id]));
}

export async function getRideById(id: string): Promise<RideRow | null> {
  return firstOrNull(await query<RideRow>("SELECT * FROM rides WHERE id = $1", [id]));
}

export async function serializeRequestById(id: string): Promise<SerializedRequest | null> {
  const row = await getRequestById(id);
  if (!row) return null;
  return serializeRequest(row, await fareLinesForRequest(id));
}

export async function serializeRideMembers(rideId: string): Promise<SerializedRequest[]> {
  const { rows } = await query<RideRequestWithNameRow>(
    `SELECT r.*, u.name AS passenger_name FROM ride_requests r
     JOIN users u ON u.id = r.passenger_id
     WHERE r.ride_id = $1 AND r.status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED', 'COMPLETED')
     ORDER BY r.created_at`,
    [rideId],
  );

  const out: SerializedRequest[] = [];
  for (const row of rows) {
    out.push(serializeRequest(row, await fareLinesForRequest(row.id)));
  }
  return out;
}

/** Co-riders as the PRD allows: first name + destination only. */
export function serializeCoRiders(
  members: readonly SerializedRequest[],
  exceptRequestId: string,
): SerializedCoRider[] {
  return members
    .filter((m) => m.id !== exceptRequestId)
    .map((m) => ({
      id: m.id,
      firstName: (m.passengerName ?? "").split(" ")[0] ?? "",
      dropStopId: m.dropStopId,
      status: m.status,
    }));
}

// ---------- mutations ----------

/**
 * Passenger creates a ride request (PRD passenger flow).
 * - Idempotency-Key replay returns the original request (duplicate-tap safe).
 * - One active request per passenger.
 * - Fare stored is the solo estimate; pooling reprices on accept/join.
 */
export async function createRequest({
  passengerId,
  pickupStopId,
  dropStopId,
  routeId,
  seats = 1,
  idempotencyKey = null,
}: {
  passengerId: string;
  pickupStopId: string;
  dropStopId: string;
  routeId?: string | null;
  seats?: number;
  idempotencyKey?: string | null;
}): Promise<{ request: SerializedRequest | null; replayed: boolean }> {
  if (idempotencyKey) {
    const existing = firstOrNull(
      await query<RideRequestRow>("SELECT id FROM ride_requests WHERE idempotency_key = $1", [
        idempotencyKey,
      ]),
    );
    if (existing) return { request: await serializeRequestById(existing.id), replayed: true };
  }

  const trip = resolveTrip({ pickupStopId, dropStopId, routeId });
  const fare = priceLegs(trip.legs);

  const created = await withTransaction(async (client) => {
    // Duplicate-tap protection (PRD stretch): one active request per passenger.
    const active = await client.query(
      `SELECT 1 FROM ride_requests
       WHERE passenger_id = $1 AND status IN ('REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED')
       LIMIT 1`,
      [passengerId],
    );
    if (rowsAffected(active) > 0) {
      throw conflict("ACTIVE_RIDE_EXISTS", "You already have a ride in progress");
    }

    const row = firstOrNull(
      await client.query<RideRequestRow>(
        `INSERT INTO ride_requests
          (passenger_id, pickup_stop, drop_stop, route_id, leg_ids, stop_ids, seats, status,
           base_fare_paisa, distance_charge_paisa, pool_discount_paisa, total_fare_paisa, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          passengerId,
          pickupStopId,
          dropStopId,
          trip.routeId,
          trip.legs.map((l) => l.id),
          trip.stopIds,
          seats,
          fare.baseFare,
          fare.distanceCharge,
          fare.poolDiscount,
          fare.total,
          idempotencyKey,
        ],
      ),
    );
    if (!row) throw new Error("INSERT ... RETURNING produced no row");

    for (let i = 0; i < fare.lines.length; i += 1) {
      const line = at(fare.lines, i);
      await client.query(
        `INSERT INTO fare_legs
          (request_id, leg_no, leg_id, from_stop, to_stop, riders_on_leg, discount_pct, price_paisa, paid_paisa)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.id,
          i,
          line.edgeId,
          line.from,
          line.to,
          line.riders,
          line.discountPct,
          line.pricePaisa,
          line.paidPaisa,
        ],
      );
    }
    await logEvent(client, { requestId: row.id, event: "REQUEST_CREATED", actorId: passengerId });
    return row;
  });

  return { request: await serializeRequestById(created.id), replayed: false };
}

/**
 * Driver accepts one or more pending requests as a new pool (PRD driver flow).
 * The whole group is claimed in one transaction: requests are locked and
 * re-checked (so two drivers racing on the same request cannot both win),
 * the ride is created with seats_taken set in the INSERT (CHECK guards
 * capacity), fares are pooled, and everything is logged.
 */
export async function acceptRequests({
  driverId,
  requestIds,
}: {
  driverId: string;
  requestIds: string[];
}): Promise<{ ride: SerializedRide; requests: SerializedRequest[] }> {
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw badRequest("requestIds must be a non-empty array");
  }

  const vehicle = await requireVehicleForDriver(driverId);
  if (!vehicle) throw forbidden("Driver has no vehicle registered");
  await requireDriverOnline(driverId);

  const busy = await query(
    `SELECT 1 FROM rides WHERE vehicle_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED') LIMIT 1`,
    [vehicle.id],
  );
  if (rowsAffected(busy) > 0) throw conflict("DRIVER_BUSY", "Finish the current trip first");

  return withTransaction(async (client) => {
    // Lock the rows so a racing driver blocks here until we commit.
    const placeholders = requestIds.map((_, i) => `$${i + 1}`).join(", ");
    const { rows: locked } = await client.query<RideRequestRow>(
      `SELECT * FROM ride_requests WHERE id IN (${placeholders}) ORDER BY created_at FOR UPDATE`,
      requestIds,
    );
    if (locked.length !== requestIds.length) throw notFound("One or more requests do not exist");
    for (const row of locked) {
      if (row.status !== "REQUESTED") {
        throw conflict(
          "REQUEST_NO_LONGER_AVAILABLE",
          `Request ${row.id} is no longer available`,
        );
      }
    }

    const seats = locked.reduce((sum, r) => sum + r.seats, 0);
    if (seats > vehicle.capacity) {
      throw conflict(
        "NOT_ENOUGH_SEATS",
        `Group needs ${seats} seats, vehicle has ${vehicle.capacity}`,
      );
    }

    // The atomic seat claim: the CHECK (seats_taken <= capacity) makes
    // overbooking impossible at the database level (PRD §11).
    const ride = firstOrNull(
      await client.query<RideRow>(
        `INSERT INTO rides (vehicle_id, status, seats_taken, capacity)
         VALUES ($1, 'MATCHED', $2, $3) RETURNING *`,
        [vehicle.id, seats, vehicle.capacity],
      ),
    );
    if (!ride) throw new Error("INSERT ... RETURNING produced no ride row");

    for (const req of locked) {
      const res = await client.query(
        `UPDATE ride_requests SET status = 'MATCHED', ride_id = $2, declined_by = '{}', updated_at = now()
         WHERE id = $1 AND status = 'REQUESTED'`,
        [req.id, ride.id],
      );
      if (rowsAffected(res) === 0) {
        throw conflict("REQUEST_NO_LONGER_AVAILABLE", `Request ${req.id} was claimed elsewhere`);
      }
    }

    await recomputeRideFares(client, ride.id);
    await logEvent(client, { rideId: ride.id, event: "MATCHED", actorId: driverId, meta: { requestIds } });

    const members: SerializedRequest[] = [];
    for (const req of locked) {
      const fresh = firstOrNull(
        await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [req.id]),
      );
      if (!fresh) throw notFound(`Request ${req.id} vanished mid-transaction`);
      members.push(serializeRequest(fresh, await fareLinesForRequest(req.id, client)));
    }
    return { ride: serializeRide(ride), requests: members };
  });
}

/**
 * Hop-on joining: a passenger can board a running trip when a seat is free.
 *
 * The path they may ride is the primary (earliest) member's ordered stop
 * list — the auto is driving that line, so get-in and get-out must both be
 * stops on it, in travel order, ahead of where the auto already is. The
 * joiner's fare is priced at the current riders-per-leg plus themselves, so
 * the preview matches what joining actually costs right now.
 */

/** Every index a stop appears at on the path (stops can repeat on loops). */
function stopIndexes(path: string[], stopId: string): number[] {
  const indexes: number[] = [];
  path.forEach((stop, i) => {
    if (stop === stopId) indexes.push(i);
  });
  return indexes;
}

/**
 * Resolve get-in/get-out to a slice of the trip path. Throws a clear 400 when
 * either stop is not on the path, the order is impossible, or the get-in is
 * behind the auto's current position.
 */
function resolveJoinSlice(
  path: string[],
  pickupStopId: string,
  dropStopId: string,
  progress: number,
): { legs: Edge[]; stopIds: string[] } {
  const pickupIndexes = stopIndexes(path, pickupStopId);
  const dropIndexes = stopIndexes(path, dropStopId);
  if (pickupIndexes.length === 0 || dropIndexes.length === 0) {
    throw badRequest("Get-in and get-out must be stops on this trip", { stops: path });
  }
  // The stop the auto is at or just left stays selectable (floor): boarding
  // as it pulls away is friendlier than a strict "already passed" dead end.
  const minGetIn = Math.floor(progress * (path.length - 1));
  const pickup = pickupIndexes.find((i) => i >= minGetIn);
  const drop = dropIndexes[dropIndexes.length - 1];
  if (pickup === undefined) {
    throw badRequest("The auto has already passed that stop", { stops: path });
  }
  if (drop === undefined) {
    throw badRequest("Get-out is not on this trip", { stops: path });
  }
  if (drop <= pickup) {
    throw badRequest("Get-out must come after get-in on this trip", { stops: path });
  }
  const stopIds = path.slice(pickup, drop + 1);
  const legs: Edge[] = [];
  for (let i = pickup; i < drop; i += 1) {
    const from = path[i];
    const to = path[i + 1];
    if (!from || !to) throw badRequest("The trip path is malformed");
    const leg = getEdge(from, to);
    if (!leg) throw badRequest("The trip path has a leg that no longer exists");
    legs.push(leg);
  }
  return { legs, stopIds };
}

/** Riders-per-leg across the current members of a ride. */
async function ridersPerLegOnRide(
  client: DbClient | null,
  rideId: string,
): Promise<Record<string, number>> {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q<{ leg_ids: string[] }>(
    `SELECT leg_ids FROM ride_requests
     WHERE ride_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')`,
    [rideId],
  );
  const ridersPerLeg: Record<string, number> = {};
  for (const row of rows) {
    for (const legId of row.leg_ids) {
      ridersPerLeg[legId] = (ridersPerLeg[legId] ?? 0) + 1;
    }
  }
  return ridersPerLeg;
}

async function vehicleById(vehicleId: string): Promise<VehicleRow | null> {
  return firstOrNull(await query<VehicleRow>("SELECT * FROM vehicles WHERE id = $1", [vehicleId]));
}

/**
 * What joining would look like right now: the trip's stops, free seats and
 * the joiner's own fare at the current occupancy. Read-only — the price can
 * change the moment someone else claims a seat, so the UI polls this.
 */
export async function joinPreview({
  passengerId,
  rideId,
  pickupStopId,
  dropStopId,
}: {
  passengerId: string;
  rideId: string;
  pickupStopId: string;
  dropStopId: string;
}): Promise<JoinPreview> {
  const ride = await getRideById(rideId);
  if (!ride) throw notFound("Ride not found");
  if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
    throw conflict("RIDE_NOT_ACTIVE", "Ride is not accepting joiners");
  }
  const active = firstOrNull(
    await query(
      `SELECT 1 FROM ride_requests
       WHERE passenger_id = $1 AND status IN ('REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED')
       LIMIT 1`,
      [passengerId],
    ),
  );
  if (active) throw conflict("ACTIVE_RIDE_EXISTS", "You are already on a ride");

  const vehicle = await vehicleById(ride.vehicle_id);
  if (!vehicle) throw notFound("Ride vehicle disappeared");

  const path = await ridePath(ride);
  if (path.length < 2) throw conflict("RIDE_EMPTY", "This ride has no route yet");
  const { live } = await liveRideFor(rideId);
  const { legs } = resolveJoinSlice(
    path,
    pickupStopId,
    dropStopId,
    live?.progress ?? 0,
  );

  const ridersPerLeg = await ridersPerLegOnRide(null, rideId);
  const joinerRidersPerLeg: RidersPerLeg = {};
  for (const leg of legs) {
    joinerRidersPerLeg[leg.id] = (ridersPerLeg[leg.id] ?? 0) + 1;
  }

  return {
    ride: serializeRide(ride),
    stops: path,
    seatsFree: vehicle.capacity - ride.seats_taken,
    fare: priceLegs(legs, joinerRidersPerLeg),
  };
}

/**
 * The hop-on itself. Same rules as the preview, enforced again inside the
 * transaction: the seat claim is one atomic conditional UPDATE (PRD §11), the
 * stop slice is re-validated against fresh state, the joiner's request is
 * born MATCHED, and every member's fare is repriced so shared-leg discounts
 * cascade to everyone already aboard.
 */
export async function joinRideByStops({
  passengerId,
  rideId,
  pickupStopId,
  dropStopId,
  idempotencyKey,
}: {
  passengerId: string;
  rideId: string;
  pickupStopId: string;
  dropStopId: string;
  idempotencyKey?: string | null;
}): Promise<{ ride: SerializedRide; request: SerializedRequest; replayed: boolean }> {
  if (idempotencyKey) {
    const existing = firstOrNull(
      await query("SELECT id FROM ride_requests WHERE idempotency_key = $1", [idempotencyKey]),
    );
    if (existing) {
      const request = await serializeRequestById(existing.id);
      if (!request) throw notFound("Ride request not found");
      const ride = request.rideId ? await getRideById(request.rideId) : null;
      if (!ride) throw conflict("RIDE_GONE", "The joined ride no longer exists");
      return { ride: serializeRide(ride), request, replayed: true };
    }
  }

  return withTransaction(async (client) => {
    const current = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]),
    );
    if (!current) throw notFound("Ride not found");
    if (!ACTIVE_RIDE_STATUSES.includes(current.status)) {
      throw conflict("RIDE_NOT_ACTIVE", "Ride is not accepting joiners");
    }

    const active = firstOrNull(
      await client.query(
        `SELECT 1 FROM ride_requests
         WHERE passenger_id = $1 AND status IN ('REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED')
         LIMIT 1`,
        [passengerId],
      ),
    );
    if (active) throw conflict("ACTIVE_RIDE_EXISTS", "You are already on a ride");

    const vehicle = await vehicleById(current.vehicle_id);
    if (!vehicle) throw notFound("Ride vehicle disappeared");

    const path = await ridePath(current);
    if (path.length < 2) throw conflict("RIDE_EMPTY", "This ride has no route yet");
    const { live } = await liveRideFor(rideId);
    const { legs, stopIds } = resolveJoinSlice(
      path,
      pickupStopId,
      dropStopId,
      live?.progress ?? 0,
    );

    // THE atomic conditional update (PRD §11): 1 row = seat claimed, 0 = full.
    const claim = await client.query(
      `UPDATE rides SET seats_taken = seats_taken + 1, updated_at = now()
       WHERE id = $1 AND seats_taken + 1 <= capacity`,
      [rideId],
    );
    if (rowsAffected(claim) === 0) {
      throw conflict("RIDE_FULL", "Seat no longer available");
    }

    const ridersPerLeg = await ridersPerLegOnRide(client, rideId);
    const joinerRidersPerLeg: RidersPerLeg = {};
    for (const leg of legs) {
      joinerRidersPerLeg[leg.id] = (ridersPerLeg[leg.id] ?? 0) + 1;
    }
    const fare = priceLegs(legs, joinerRidersPerLeg);

    const inserted = await client.query<RideRequestRow>(
      `INSERT INTO ride_requests
        (passenger_id, ride_id, pickup_stop, drop_stop, route_id, leg_ids, stop_ids, seats,
         status, base_fare_paisa, distance_charge_paisa, pool_discount_paisa, total_fare_paisa,
         idempotency_key)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, 1, 'MATCHED', $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        passengerId, rideId, pickupStopId, dropStopId,
        legs.map((l) => l.id), stopIds,
        fare.baseFare, fare.distanceCharge, fare.poolDiscount, fare.total,
        idempotencyKey ?? null,
      ],
    );
    const request = inserted.rows[0];
    if (!request) throw new Error("INSERT ... RETURNING produced no request row");

    for (const [i, line] of fare.lines.entries()) {
      await client.query(
        `INSERT INTO fare_legs
          (request_id, leg_no, leg_id, from_stop, to_stop, riders_on_leg, discount_pct, price_paisa, paid_paisa)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [request.id, i, line.edgeId, line.from, line.to, line.riders, line.discountPct, line.pricePaisa, line.paidPaisa],
      );
    }

    // Everyone already aboard gets the new shared-leg discounts.
    await recomputeRideFares(client, rideId);
    await logEvent(client, { rideId, requestId: request.id, event: "JOINED", actorId: passengerId });

    // Serialize through the transaction's client — the pool cannot see
    // rows this transaction has not committed yet.
    const freshRow = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [request.id]),
    );
    const freshRide = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (!freshRow || !freshRide) throw new Error("Ride or request disappeared mid-join");
    return {
      ride: serializeRide(freshRide),
      request: serializeRequest(freshRow, await fareLinesForRequest(request.id, client)),
      replayed: false,
    };
  });
}

/**
 * Driver admits a pre-booked (REQUESTED) passenger into their own running
 * ride — the counterpart to hop-on self-joining, for riders who requested
 * before the trip existed. Same atomic seat claim, same reprice cascade.
 */
export async function admitRider({
  driverId,
  rideId,
  requestId,
}: {
  driverId: string;
  rideId: string;
  requestId: string;
}): Promise<{ ride: SerializedRide; request: SerializedRequest }> {
  const vehicle = await requireVehicleForDriver(driverId);
  if (!vehicle) throw forbidden("Driver has no vehicle registered");
  await requireDriverOnline(driverId);

  return withTransaction(async (client) => {
    const current = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]),
    );
    if (!current) throw notFound("Ride not found");
    if (current.vehicle_id !== vehicle.id) throw forbidden("Not your ride");
    if (!ACTIVE_RIDE_STATUSES.includes(current.status)) {
      throw conflict("RIDE_NOT_ACTIVE", "Ride is not taking riders");
    }

    const pending = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1 FOR UPDATE", [
        requestId,
      ]),
    );
    if (!pending) throw notFound("Request not found");
    if (pending.status !== "REQUESTED") {
      throw conflict("REQUEST_NO_LONGER_AVAILABLE", "Request is no longer available");
    }

    // Pooling rule: the rider's legs must overlap the trip that is running.
    const members = await serializeRideMembers(rideId);
    const memberLegs = new Set(members.flatMap((m) => m.legIds));
    if (!pending.leg_ids.some((id) => memberLegs.has(id))) {
      throw conflict("NOT_POOLABLE", "Route does not overlap with the current trip");
    }

    // THE atomic conditional update (PRD §11): 1 row = seat claimed, 0 = full.
    const claim = await client.query(
      `UPDATE rides SET seats_taken = seats_taken + $2, updated_at = now()
       WHERE id = $1 AND seats_taken + $2 <= capacity`,
      [rideId, pending.seats],
    );
    if (rowsAffected(claim) === 0) {
      throw conflict("RIDE_FULL", "Seat no longer available");
    }

    const attach = await client.query(
      `UPDATE ride_requests SET status = 'MATCHED', ride_id = $2, updated_at = now()
       WHERE id = $1 AND status = 'REQUESTED'`,
      [requestId, rideId],
    );
    if (rowsAffected(attach) === 0) {
      throw conflict("REQUEST_NO_LONGER_AVAILABLE", "Request was claimed elsewhere");
    }

    await recomputeRideFares(client, rideId);
    await logEvent(client, { rideId, requestId, event: "JOINED", actorId: driverId });

    const freshRow = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [requestId]),
    );
    const freshRide = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (!freshRow || !freshRide) throw new Error("Ride or request disappeared mid-admit");
    return {
      ride: serializeRide(freshRide),
      request: serializeRequest(freshRow, await fareLinesForRequest(requestId, client)),
    };
  });
}

// ---------- driver decline, wait-and-save, passenger finish ----------

/**
 * Driver declines a pending request: it disappears from THEIR pending list
 * but stays open for every other driver — the pool isn't one driver's to kill.
 */
export async function declineRequest({
  driverId,
  requestId,
}: {
  driverId: string;
  requestId: string;
}): Promise<{ requestId: string; declined: true }> {
  return withTransaction(async (client) => {
    const row = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1 FOR UPDATE", [requestId]),
    );
    if (!row) throw notFound("Request not found");
    if (row.status !== "REQUESTED") {
      throw conflict("REQUEST_NO_LONGER_AVAILABLE", "Request is no longer available");
    }
    await client.query(
      `UPDATE ride_requests SET declined_by = array_append(declined_by, $2), updated_at = now()
       WHERE id = $1`,
      [requestId, driverId],
    );
    await logEvent(client, { requestId, event: "DECLINED", actorId: driverId });
    return { requestId, declined: true };
  });
}

/**
 * Wait-and-Save: after being matched, the passenger may hold their seat for
 * a short window (demo 30s) to earn an extra 5% off — the driver gets time to
 * fill the car, the rider gets a better deal. Answerable once; the promise is
 * only honoured if it runs out before the trip completes.
 */
export async function setWaitAndSave({
  passengerId,
  requestId,
  accept,
}: {
  passengerId: string;
  requestId: string;
  accept: boolean;
}): Promise<SerializedRequest> {
  const request = await getRequestById(requestId);
  if (!request) throw notFound("Ride request not found");
  if (request.passenger_id !== passengerId) throw forbidden("You can only change your own ride");
  if (request.status !== "MATCHED" && request.status !== "DRIVER_ARRIVED") {
    throw conflict("OFFER_CLOSED", "The wait-and-save offer only applies before the trip starts");
  }
  if (request.wait_decided_at) {
    throw conflict("ALREADY_DECIDED", "You have already answered the wait-and-save offer");
  }

  const deadline = accept ? new Date(Date.now() + WAIT_AND_SAVE_SECONDS * 1000) : null;
  await query(
    `UPDATE ride_requests
     SET wait_and_save = $2, wait_deadline = $3, wait_decided_at = now(), updated_at = now()
     WHERE id = $1`,
    [requestId, accept, deadline],
  );
  await withTransaction(async (client) => {
    await logEvent(client, {
      requestId,
      rideId: request.ride_id,
      event: accept ? "WAIT_AND_SAVE_ACCEPTED" : "WAIT_AND_SAVE_DECLINED",
      actorId: passengerId,
      meta: accept ? { seconds: WAIT_AND_SAVE_SECONDS, extraPct: WAIT_AND_SAVE_EXTRA_PCT } : null,
    });
  });
  const fresh = await serializeRequestById(requestId);
  if (!fresh) throw notFound("Ride request not found");
  return fresh;
}

/**
 * Honour every honoured wait on the ride: each member who accepted
 * Wait-and-Save and whose deadline passed before this instant gets an extra
 * WAIT_AND_SAVE_EXTRA_PCT off their distance charge (folded into
 * pool_discount_paisa so base + distance − discount still reconciles).
 */
async function applyWaitAndSave(client: DbClient, rideId: string): Promise<number> {
  const { rows } = await client.query<RideRequestRow>(
    `SELECT * FROM ride_requests
     WHERE ride_id = $1 AND wait_and_save = TRUE AND wait_deadline IS NOT NULL
       AND wait_deadline <= now()`,
    [rideId],
  );
  for (const row of rows) {
    if (row.pool_discount_paisa >= Math.round((row.distance_charge_paisa * 100) / 90)) {
      // Already carries the wait discount (90% of distance): never double-apply.
      continue;
    }
    const extra = Math.round((row.distance_charge_paisa * WAIT_AND_SAVE_EXTRA_PCT) / 100);
    const discount = row.pool_discount_paisa + extra;
    await client.query(
      `UPDATE ride_requests
       SET pool_discount_paisa = $2, total_fare_paisa = $3, updated_at = now()
       WHERE id = $1`,
      [row.id, discount, row.base_fare_paisa + row.distance_charge_paisa - discount],
    );
    await logEvent(client, {
      rideId,
      requestId: row.id,
      event: "WAIT_AND_SAVE_APPLIED",
      meta: { extraPaisa: extra },
    });
  }
  return rows.length;
}

/**
 * Passenger marks their own leg finished ("I'm out at my stop"). Their
 * membership completes and leaves the seat pool; when nobody is left riding,
 * the whole ride completes.
 */
export async function finishRideForPassenger({
  passengerId,
  requestId,
}: {
  passengerId: string;
  requestId: string;
}): Promise<{ request: SerializedRequest; ride: SerializedRide }> {
  return withTransaction(async (client) => {
    const row = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1 FOR UPDATE", [requestId]),
    );
    if (!row) throw notFound("Ride request not found");
    if (row.passenger_id !== passengerId) throw forbidden("You can only finish your own ride");
    if (row.status !== "STARTED" && row.status !== "MATCHED" && row.status !== "DRIVER_ARRIVED") {
      throw conflict("NOT_IN_PROGRESS", "This ride is not in progress");
    }
    const rideId = row.ride_id;
    if (!rideId) throw conflict("NOT_IN_PROGRESS", "This ride is not in progress");

    await client.query(
      `UPDATE ride_requests SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
      [requestId],
    );
    await applyWaitAndSave(client, rideId);
    await logEvent(client, { rideId, requestId, event: "DROPPED_OFF", actorId: passengerId });

    const { rowCount: left } = await client.query(
      `SELECT 1 FROM ride_requests
       WHERE ride_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED') LIMIT 1`,
      [rideId],
    );
    let ride = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (left === 0 && ride) {
      await client.query(
        `UPDATE rides SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
        [rideId],
      );
      await logEvent(client, { rideId, event: "COMPLETED" });
      ride = firstOrNull(await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]));
    }
    if (!ride) throw new Error("Ride disappeared mid-finish");
    // Read through the transaction client — the pool cannot see our writes yet.
    const freshRow = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [requestId]),
    );
    if (!freshRow) throw new Error("Request disappeared mid-finish");
    return {
      request: serializeRequest(freshRow, await fareLinesForRequest(requestId, client)),
      ride: serializeRide(ride),
    };
  });
}

/**
 * Passenger cancel (PRD §4): allowed from REQUESTED through DRIVER_ARRIVED.
 * Frees the seat, reprices remaining riders, cancels an unstarted ride that
 * has nobody left on it.
 */
export async function cancelRequest({
  requestId,
  actorId,
  actorRole,
  reason = null,
}: {
  requestId: string;
  actorId: string;
  actorRole: Role;
  reason?: string | null;
}): Promise<SerializedRequest | null> {
  await withTransaction(async (client) => {
    const request = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1 FOR UPDATE", [
        requestId,
      ]),
    );
    if (!request) throw notFound("Ride request not found");
    if (actorRole === "passenger" && request.passenger_id !== actorId) {
      throw forbidden("You can only cancel your own ride");
    }
    if (!isCancellable(request.status)) {
      throw conflict("NOT_CANCELLABLE", `Ride cannot be cancelled from ${request.status}`);
    }

    const previous = request.status;
    const cancelled = await client.query(
      `UPDATE ride_requests SET status = 'CANCELLED', ride_id = NULL, cancel_reason = $2, updated_at = now()
       WHERE id = $1`,
      [requestId, reason],
    );
    if (rowsAffected(cancelled) === 0) throw conflict("NOT_CANCELLABLE", "Ride cannot be cancelled");

    await logEvent(client, {
      rideId: request.ride_id,
      requestId,
      event: "CANCELLED",
      actorId,
      meta: { from: previous, reason },
    });

    if (request.ride_id) {
      // Free the seat and reprice whoever is still on the ride.
      await client.query(
        `UPDATE rides SET seats_taken = GREATEST(0, seats_taken - $2), updated_at = now() WHERE id = $1`,
        [request.ride_id, request.seats],
      );
      await recomputeRideFares(client, request.ride_id);

      const left = await client.query(
        `SELECT 1 FROM ride_requests
         WHERE ride_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED') LIMIT 1`,
        [request.ride_id],
      );
      const parent = firstOrNull(
        await client.query<Pick<RideRow, "status">>(
          "SELECT status FROM rides WHERE id = $1",
          [request.ride_id],
        ),
      );
      if (rowsAffected(left) === 0 && parent && parent.status !== "STARTED") {
        await client.query(
          `UPDATE rides SET status = 'CANCELLED', updated_at = now() WHERE id = $1`,
          [request.ride_id],
        );
        await logEvent(client, {
          rideId: request.ride_id,
          event: "CANCELLED",
          actorId,
          meta: { because: "no riders left" },
        });
      }
    }
  });

  // Serialize after commit — a read on another connection cannot see the
  // transaction's uncommitted writes.
  return serializeRequestById(requestId);
}

/**
 * Driver ride transition: arrived / start / complete. Applies the PRD §4
 * state machine to the ride and mirrors it onto all matched requests.
 */
export async function advanceRide({
  rideId,
  driverId,
  next,
}: {
  rideId: string;
  driverId: string;
  next: RideStatus;
}): Promise<{ ride: SerializedRide }> {
  return withTransaction(async (client) => {
    const ride = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]),
    );
    if (!ride) throw notFound("Ride not found");

    const vehicle = await requireVehicleForDriver(driverId);
    if (ride.vehicle_id !== vehicle?.id) throw forbidden("Not your ride");

    if (!ALLOWED_NEXT[ride.status]?.includes(next)) {
      throw conflict("INVALID_TRANSITION", `Cannot go from ${ride.status} to ${next}`);
    }

    await client.query("UPDATE rides SET status = $2, updated_at = now() WHERE id = $1", [
      rideId,
      next,
    ]);
    await client.query(
      `UPDATE ride_requests SET status = $2, updated_at = now()
       WHERE ride_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')`,
      [rideId, next],
    );
    await logEvent(client, { rideId, event: next, actorId: driverId });
    if (next === "COMPLETED") await applyWaitAndSave(client, rideId);

    const fresh = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (!fresh) throw new Error("Ride disappeared mid-transition");
    return { ride: serializeRide(fresh) };
  });
}

export async function rateRequest({
  requestId,
  passengerId,
  rating,
}: {
  requestId: string;
  passengerId: string;
  rating: number;
}): Promise<SerializedRequest | null> {
  const request = await getRequestById(requestId);
  if (!request) throw notFound("Ride request not found");
  if (request.passenger_id !== passengerId) throw forbidden("You can only rate your own ride");
  if (request.status !== "COMPLETED") {
    throw conflict("NOT_COMPLETED", "You can rate after the ride completes");
  }
  await query("UPDATE ride_requests SET rating = $2, updated_at = now() WHERE id = $1", [
    requestId,
    rating,
  ]);
  return serializeRequestById(requestId);
}

// ---------- driver state ----------

export async function requireVehicleForDriver(driverId: string): Promise<VehicleRow | null> {
  return firstOrNull(await query<VehicleRow>("SELECT * FROM vehicles WHERE driver_id = $1", [driverId]));
}

/**
 * Viewing pending requests is allowed while offline (a demand preview), but
 * claiming seats is not — the offline toggle is enforced here, server-side,
 * not just disabled in the UI.
 */
async function requireDriverOnline(driverId: string): Promise<void> {
  const row = firstOrNull(await query<Pick<UserRow, "is_online">>("SELECT is_online FROM users WHERE id = $1", [driverId]));
  if (!row?.is_online) {
    throw conflict("DRIVER_OFFLINE", "Go online to accept rides");
  }
}

/** Pending REQUESTED requests grouped greedily by shared legs (poolable). */
export async function pendingPoolGroups(viewerDriverId?: string): Promise<PoolGroup[]> {
  // A request a driver declined vanishes from THEIR list only — it stays open
  // for every other driver, and the first accept anywhere claims it.
  const { rows } = await query<RideRequestWithNameRow>(
    `SELECT r.*, u.name AS passenger_name FROM ride_requests r
     JOIN users u ON u.id = r.passenger_id
     WHERE r.status = 'REQUESTED'
       AND NOT ($1::text IS NULL OR r.declined_by @> ARRAY[$1::text])
     ORDER BY r.created_at`,
    [viewerDriverId ?? null],
  );

  const groups: RideRequestWithNameRow[][] = [];
  for (const row of rows) {
    const group = groups.find((g) => g.some((m) => m.leg_ids.some((id) => row.leg_ids.includes(id))));
    if (group) group.push(row);
    else groups.push([row]);
  }

  return groups.map((group) => ({
    requestIds: group.map((g) => g.id),
    seats: group.reduce((s, g) => s + g.seats, 0),
    requests: group.map((g) => serializeRequest(g)),
  }));
}

export async function driverState(driverId: string): Promise<DriverState> {
  const vehicle = await requireVehicleForDriver(driverId);
  if (!vehicle) throw notFound("Driver has no vehicle registered");
  const user = await query<UserRow>("SELECT * FROM users WHERE id = $1", [driverId]);
  const driverRow = firstOrNull(user);
  if (!driverRow) throw notFound("User not found");

  const activeRide = firstOrNull(
    await query<RideRow>(
      `SELECT * FROM rides WHERE vehicle_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED') LIMIT 1`,
      [vehicle.id],
    ),
  );
  const members = activeRide ? await serializeRideMembers(activeRide.id) : [];
  const groups = await pendingPoolGroups(driverId);

  const earnings = firstOrNull(
    await query<EarningsRow>(
      `SELECT COALESCE(SUM(r.total_fare_paisa), 0) AS earned, COUNT(*) AS trips
       FROM ride_requests r JOIN rides ri ON r.ride_id = ri.id
       WHERE ri.vehicle_id = $1 AND r.status = 'COMPLETED'`,
      [vehicle.id],
    ),
  );

  return {
    online: driverRow.is_online,
    vehicle: { id: vehicle.id, name: vehicle.name, capacity: vehicle.capacity },
    activeTrip: activeRide ? { ...serializeRide(activeRide), requests: members } : null,
    pendingGroups: groups.map((g) => ({ ...g, fits: g.seats <= vehicle.capacity })),
    earnings: {
      totalPaisa: Number(earnings?.earned ?? 0),
      completedTrips: Number(earnings?.trips ?? 0),
    },
  };
}

export async function driverHistory(driverId: string): Promise<DriverTrip[]> {
  const vehicle = await requireVehicleForDriver(driverId);
  const { rows } = await query<RideRow>(
    `SELECT * FROM rides WHERE vehicle_id = $1 AND status IN ('COMPLETED', 'CANCELLED') ORDER BY updated_at DESC`,
    [vehicle?.id ?? null],
  );

  const out: DriverTrip[] = [];
  for (const ride of rows) {
    out.push({
      ...serializeRide(ride),
      requests: await serializeRideMembers(ride.id),
      events: await eventsForRide(ride.id),
    });
  }
  return out;
}

// ---------- passenger reads ----------

export async function activeRequestForPassenger(
  passengerId: string,
): Promise<ActivePassengerView | null> {
  const request = firstOrNull(
    await query<RideRequestRow>(
      `SELECT * FROM ride_requests
       WHERE passenger_id = $1
         AND (status IN ('REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED')
              OR updated_at > now() - interval '5 minutes')
       ORDER BY created_at DESC
       LIMIT 1`,
      [passengerId],
    ),
  );
  if (!request) return null;

  const result: ActivePassengerView = {
    request: serializeRequest(request, await fareLinesForRequest(request.id)),
  };

  if (request.ride_id) {
    const ride = await getRideById(request.ride_id);
    result.trip = ride ? serializeRide(ride) : null;
    if (ride) {
      const vehicle = firstOrNull(
        await query<VehicleWithDriverRow>(
          `SELECT v.*, u.name AS driver_name FROM vehicles v
           JOIN users u ON u.id = v.driver_id WHERE v.id = $1`,
          [ride.vehicle_id],
        ),
      );
      result.vehicle = vehicle
        ? {
            id: vehicle.id,
            name: vehicle.name,
            capacity: vehicle.capacity,
            driverName: vehicle.driver_name,
          }
        : null;
      const members = await serializeRideMembers(ride.id);
      result.coRiders = serializeCoRiders(members, request.id);
    }
  }
  return result;
}

export async function passengerHistory(passengerId: string): Promise<SerializedRequest[]> {
  const { rows } = await query<RideRequestRow>(
    `SELECT * FROM ride_requests
     WHERE passenger_id = $1 AND status IN ('COMPLETED', 'CANCELLED')
     ORDER BY created_at DESC`,
    [passengerId],
  );

  const out: SerializedRequest[] = [];
  for (const row of rows) {
    out.push(serializeRequest(row, await fareLinesForRequest(row.id)));
  }
  return out;
}
