import { firstOrNull, query, rowsAffected, withTransaction } from "../../shared/db.js";
import type { DbClient } from "../../shared/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import {
  WAIT_SAVE_MINUTES,
  edgeByLegId,
  edgeKey,
  getRoute,
  legsBetween,
  priceLegs,
  shortestPath,
} from "../../graph/index.js";
import {
  driverIdForRide,
  settleRidePayment,
} from "../wallet/wallet.service.js";
import type { Edge, RidersPerLeg } from "../../graph/index.js";
import type {
  Fare,
  RequestStatus,
  FareLegRow,
  FareLine,
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
  ALLOWED_NEXT,
  STAGE_RANK,
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
  /**
   * The whole trip's ordered stops, not just this rider's slice of them.
   *
   * Everyone on one Tesla shares one line on the map: a rider who joined at
   * Gulshan 1 still draws Banani → Gulshan 1 → Gulshan 2 → Gulshan 1 →
   * Mohakhali, because that is the journey the car is actually making.
   */
  routeStopIds?: string[];
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
    // Travel order, not corridor order. `legsBetween` reverses the legs when
    // the rider is heading downhill along the corridor, so the stops have to
    // follow: a Mohakhali -> Banani trip must not store its stops running
    // Banani -> Mohakhali, or the map animates the auto backwards.
    const stopIds =
      i < j ? route.stops.slice(i, j + 1) : route.stops.slice(j, i + 1).reverse();
    return { routeId, legs, stopIds };
  }

  // No corridor given: the single fastest path through the graph.
  const path = shortestPath(pickupStopId, dropStopId, "durationMin");
  if (!path) throw badRequest("No route connects these stops in the demo graph");
  return { routeId: null, legs: path.legs, stopIds: path.stops };
}

/**
 * Ordered union of every member's stops, first-seen order preserved.
 *
 * This is the trip's *whole* route. Individual riders each carry only the
 * slice they ride — two riders on one Tesla should see one line on the map,
 * not two overlapping ones — so the map always draws this.
 */
export function orderedRoute(stopLists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const route: string[] = [];
  for (const stops of stopLists) {
    for (const stop of stops) {
      if (!seen.has(stop)) {
        seen.add(stop);
        route.push(stop);
      }
    }
  }
  return route;
}

/**
 * Leg ids between two stops on an ordered route, sliced to [fromIndex, toIndex].
 *
 * Used by hop-on, where the passenger's pickup and drop are both stops the
 * running trip has not reached yet.
 */
export function legIdsBetween(
  routeStopIds: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  const ids: string[] = [];
  for (let i = fromIndex; i < toIndex; i += 1) {
    const a = routeStopIds[i];
    const b = routeStopIds[i + 1];
    if (a === undefined || b === undefined) continue;
    ids.push(edgeKey(a, b));
  }
  return ids;
}

// ---------- fares ----------

function fareFromRow(row: RideRequestRow, lines: FareLine[]): Fare {
  return {
    baseFare: row.base_fare_paisa,
    distanceCharge: row.distance_charge_paisa,
    poolDiscount: row.pool_discount_paisa,
    waitSaveDiscount: row.wait_save_discount_paisa,
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
    paymentMethod: row.payment_method,
    settled: row.settled_at !== null,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
  };
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

  // Wait & Save belongs to the one rider who booked first and held the car
  // while it filled up. "First" is measured across every member of the ride
  // rather than off `rows`, which only holds the riders still aboard: reading
  // it off `rows` handed the discount to whoever was left behind the moment
  // the original rider was dropped off, and it migrated again on every
  // cancel. A cancelled request clears its ride_id, so it drops out of this
  // query on its own and the slot passes to whoever is genuinely holding the
  // car now. Joiners (second and later passengers) never carry wait_and_save
  // at all, so they can never be this rider either.
  const { rows: allMembers } = await client.query<{ id: string }>(
    `SELECT id FROM ride_requests WHERE ride_id = $1 ORDER BY created_at LIMIT 1`,
    [rideId],
  );
  const firstRequestId = allMembers[0]?.id ?? null;

  for (const req of rows) {
    const legs = req.leg_ids.map(edgeByLegId);
    const earnsWaitSave = req.wait_and_save && req.id === firstRequestId;
    const fare = priceLegs(legs, ridersPerLeg, earnsWaitSave);

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
           wait_save_discount_paisa = $5, total_fare_paisa = $6, updated_at = now()
       WHERE id = $1`,
      [
        req.id,
        fare.baseFare,
        fare.distanceCharge,
        fare.poolDiscount,
        fare.waitSaveDiscount,
        fare.total,
      ],
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
  waitAndSave = false,
  paymentMethod = "CASH",
}: {
  passengerId: string;
  pickupStopId: string;
  dropStopId: string;
  routeId?: string | null;
  seats?: number;
  idempotencyKey?: string | null;
  waitAndSave?: boolean;
  paymentMethod?: "CASH" | "WALLET";
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
  const fare = priceLegs(trip.legs, {}, waitAndSave);

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
           base_fare_paisa, distance_charge_paisa, pool_discount_paisa,
           wait_save_discount_paisa, total_fare_paisa, idempotency_key,
           wait_and_save, wait_deadline, payment_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', $8, $9, $10, $11, $12, $13,
                 $14, now() + make_interval(mins => $15), $16)
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
          fare.waitSaveDiscount,
          fare.total,
          idempotencyKey,
          waitAndSave,
          waitAndSave ? WAIT_SAVE_MINUTES : 0,
          paymentMethod,
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
        `UPDATE ride_requests SET status = 'MATCHED', ride_id = $2, updated_at = now()
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
 * Mid-trip joiner (PRD pool engine): adds a pending request to an existing
 * active ride when a seat is free and routes overlap. Seat claim is one
 * atomic conditional UPDATE — a losing racer sees 0 rows and gets a clean 409.
 */
export async function joinRide({
  driverId,
  rideId,
  requestId,
}: {
  driverId: string;
  rideId: string;
  requestId: string;
}): Promise<{ ride: SerializedRide; request: SerializedRequest }> {
  const vehicle = await requireVehicleForDriver(driverId);
  const ride = await getRideById(rideId);
  if (!ride) throw notFound("Ride not found");
  if (ride.vehicle_id !== vehicle?.id) throw forbidden("Not your ride");

  return withTransaction(async (client) => {
    const current = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]),
    );
    if (!current) throw notFound("Ride not found");
    if (!ACTIVE_RIDE_STATUSES.includes(current.status)) {
      throw conflict("RIDE_NOT_ACTIVE", "Ride is not accepting joiners");
    }

    const request = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1 FOR UPDATE", [
        requestId,
      ]),
    );
    if (!request) throw notFound("Request not found");
    if (request.status !== "REQUESTED") {
      throw conflict("REQUEST_NO_LONGER_AVAILABLE", "Request is no longer available");
    }

    // Pooling rule: overlap with at least one current member.
    const { rows: members } = await client.query<{ leg_ids: string[] }>(
      `SELECT leg_ids FROM ride_requests
       WHERE ride_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')`,
      [rideId],
    );
    const memberLegs = new Set(members.flatMap((m) => m.leg_ids));
    if (!request.leg_ids.some((id) => memberLegs.has(id))) {
      throw conflict("NOT_POOLABLE", "Route does not overlap with the current trip");
    }

    // THE atomic conditional update (PRD §11): 1 row = seat claimed, 0 = full.
    const claim = await client.query(
      `UPDATE rides SET seats_taken = seats_taken + $2, updated_at = now()
       WHERE id = $1 AND seats_taken + $2 <= capacity`,
      [rideId, request.seats],
    );
    if (rowsAffected(claim) === 0) {
      throw conflict("RIDE_FULL", "Seat no longer available");
    }

    const attach = await client.query(
      // A joiner always boards at MATCHED — "the driver accepted this
      // request" — even when the car is already under way. Inheriting the
      // ride's current stage made a brand-new rider appear halfway through a
      // journey they had not started, and it skipped the driver's own "I have
      // arrived" confirmation for their pickup stop.
      `UPDATE ride_requests SET status = $3, ride_id = $2, updated_at = now()
       WHERE id = $1 AND status = 'REQUESTED'`,
      [requestId, rideId, "MATCHED"],
    );
    if (rowsAffected(attach) === 0) {
      throw conflict("REQUEST_NO_LONGER_AVAILABLE", "Request was claimed elsewhere");
    }

    await recomputeRideFares(client, rideId);
    await logEvent(client, { rideId, requestId, event: "JOINED", actorId: driverId });

    const updated = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [requestId]),
    );
    const freshRide = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (!updated || !freshRide) throw new Error("Ride or request disappeared mid-join");

    return {
      ride: serializeRide(freshRide),
      request: serializeRequest(updated, await fareLinesForRequest(requestId, client)),
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
 * Ride transition: arrived / start / complete.
 *
 * Either side may close the trip out. The driver running the ride can always
 * drive it, and a passenger on the ride can `complete` too — in the demo they
 * are the other half of the journey, and letting them close a run that has
 * clearly finished is friendlier than leaving the ride stuck at STARTED because
 * the driver walked away. They cannot touch arrived/start, and they cannot
 * finish a ride they are not part of.
 *
 * Completing cascades to every rider on the ride: the auto has finished the
 * whole run, whoever pressed the button. A passenger who wants only their own
 * seat closed out uses the per-rider drop-off, which the driver drives.
 */
export async function advanceRide({
  rideId,
  actorId,
  actorRole,
  next,
}: {
  rideId: string;
  actorId: string;
  actorRole: Role;
  next: RideStatus;
}): Promise<{ ride: SerializedRide }> {
  return withTransaction(async (client) => {
    const ride = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]),
    );
    if (!ride) throw notFound("Ride not found");

    if (actorRole === "driver") {
      const vehicle = await requireVehicleForDriver(actorId);
      if (ride.vehicle_id !== vehicle?.id) throw forbidden("Not your ride");
    } else {
      // Passengers may only ever complete, and only their own ride.
      if (next !== "COMPLETED") throw forbidden("Only the driver can move the trip along");
      const onBoard = await client.query(
        `SELECT 1 FROM ride_requests
         WHERE ride_id = $1 AND passenger_id = $2
           AND status IN ('MATCHED','DRIVER_ARRIVED','STARTED')
         LIMIT 1`,
        [rideId, actorId],
      );
      if (rowsAffected(onBoard) === 0) throw forbidden("You are not on this ride");
    }

    if (!ALLOWED_NEXT[ride.status]?.includes(next)) {
      throw conflict("INVALID_TRANSITION", `Cannot go from ${ride.status} to ${next}`);
    }

    // Stamp the trip clock exactly once, on the way into STARTED. Written
    // separately from the status update because it must never be rewritten by
    // any later transition -- that is what keeps every client's auto in the
    // same place for the whole ride.
    if (next === "STARTED") {
      await client.query(
        `UPDATE rides SET status = $2, started_at = COALESCE(started_at, now()), updated_at = now()
         WHERE id = $1`,
        [rideId, next],
      );
    } else {
      await client.query("UPDATE rides SET status = $2, updated_at = now() WHERE id = $1", [
        rideId,
        next,
      ]);
    }
    await client.query(
      `UPDATE ride_requests SET status = $2, updated_at = now()
       WHERE ride_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')`,
      [rideId, next],
    );
    await logEvent(client, { rideId, event: next, actorId });

    // Finishing the whole trip settles every rider who just completed.
    if (next === "COMPLETED") {
      const { rows: finishing } = await client.query<{ id: string }>(
        `SELECT id FROM ride_requests
         WHERE ride_id = $1 AND status = 'COMPLETED' AND settled_at IS NULL
           AND payment_method = 'WALLET'`,
        [rideId],
      );
      for (const r of finishing) {
        await settleIfOwed(client, rideId, r.id);
      }
    }

    const fresh = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (!fresh) throw new Error("Ride disappeared mid-transition");
    return { ride: serializeRide(fresh) };
  });
}

/**
 * Charge a just-finished rider's fare to the driver, if they paid by wallet.
 *
 * Shared by every path that can finish a ride so the money moves exactly once
 * and `settled_at` guards the rest.
 */
async function settleIfOwed(
  client: DbClient,
  rideId: string,
  requestId: string,
): Promise<void> {
  const { rows } = await client.query<{
    id: string;
    passenger_id: string;
    payment_method: string;
    total_fare_paisa: number;
    settled_at: Date | null;
  }>(
    `SELECT id, passenger_id, payment_method, total_fare_paisa, settled_at
     FROM ride_requests WHERE id = $1 AND ride_id = $2`,
    [requestId, rideId],
  );
  const row = rows[0];
  if (!row) return;

  const driverId = await driverIdForRide(client, rideId);
  if (!driverId) return;

  await settleRidePayment(client, row, driverId);
}

/**
 * Move ONE rider a single step through the lifecycle, independently of the
 * others.
 *
 * The trip as a whole has one vehicle, but the driver is picking people up
 * and setting them down at different points, so each rider's track advances
 * on its own: the second rider still has "arrived" and "start" to be marked
 * even after the first has been dropped off. The ride row is then re-synced
 * to the furthest stage anyone has reached, so the trip still reads as one
 * coherent journey rather than contradicting its own riders.
 */
export async function advanceRider({
  rideId,
  requestId,
  actorId,
}: {
  rideId: string;
  requestId: string;
  actorId: string;
}): Promise<{ request: SerializedRequest; ride: SerializedRide }> {
  return withTransaction(async (client) => {
    const ride = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]),
    );
    if (!ride) throw notFound("Ride not found");

    const vehicle = await requireVehicleForDriver(actorId);
    if (ride.vehicle_id !== vehicle?.id) throw forbidden("Not your ride");

    const request = firstOrNull(
      await client.query<RideRequestRow>(
        `SELECT * FROM ride_requests WHERE id = $1 AND ride_id = $2 FOR UPDATE`,
        [requestId, rideId],
      ),
    );
    if (!request) throw notFound("That rider is not on this ride");

    // MATCHED -> DRIVER_ARRIVED -> STARTED -> COMPLETED, one step at a time.
    const next = ALLOWED_NEXT[request.status]?.find((s) => s !== "CANCELLED") as
      | RequestStatus
      | undefined;
    if (!next) throw conflict("INVALID_TRANSITION", `Cannot advance a ${request.status} rider`);

    await client.query(
      `UPDATE ride_requests SET status = $2, updated_at = now() WHERE id = $1`,
      [requestId, next],
    );
    await logEvent(client, { rideId, requestId, event: next, actorId });

    // A rider reaching COMPLETED owes their fare to the driver.
    if (next === "COMPLETED") {
      await settleIfOwed(client, rideId, requestId);
    }

    // Keep the trip row consistent with the riders still aboard. Completed
    // riders are deliberately excluded: someone already dropped off must not
    // drag the whole trip forward and complete it early.
    const { rows: aboard } = await client.query<{ status: RequestStatus }>(
      `SELECT status FROM ride_requests
       WHERE ride_id = $1 AND status IN ('MATCHED','DRIVER_ARRIVED','STARTED')`,
      [rideId],
    );
    if (aboard.length === 0) {
      // Nobody left on board — the trip is over.
      await client.query(
        `UPDATE rides SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
        [rideId],
      );
    } else {
      const furthest = aboard
        .map((r) => r.status)
        .reduce<RequestStatus>(
          (acc, s) => (STAGE_RANK[s] > STAGE_RANK[acc] ? s : acc),
          "MATCHED" as RequestStatus,
        );
      if (STAGE_RANK[furthest] > STAGE_RANK[ride.status]) {
        // A rider being started can drag the ride into STARTED too, so the
        // trip clock has to be anchored here as well. COALESCE keeps it
        // immutable once the trip-level transition already set it.
        await client.query(
          `UPDATE rides
              SET status = $2,
                  started_at = CASE WHEN $2 = 'STARTED'
                                    THEN COALESCE(started_at, now())
                                    ELSE started_at END,
                  updated_at = now()
            WHERE id = $1`,
          [rideId, furthest],
        );
      }
    }

    const freshRequest = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [requestId]),
    );
    const freshRide = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (!freshRequest || !freshRide) throw new Error("ride or request vanished mid advance");

    return { request: serializeRequest(freshRequest), ride: serializeRide(freshRide) };
  });
}

/**
 * Drop one rider off, then finish the ride once nobody is left on board.
 *
 * A pooled trip does not end all at once: the auto reaches Gulshan 1, Rafiq
 * gets out, and the remaining riders carry on to Mohakhali. Completing each
 * rider separately is what makes that legible — and when the last one leaves,
 * the ride itself completes rather than lingering at STARTED.
 */
export async function dropOffRider({
  rideId,
  requestId,
  actorId,
}: {
  rideId: string;
  requestId: string;
  actorId: string;
}): Promise<{ ride: SerializedRide; request: SerializedRequest; rideCompleted: boolean }> {
  return withTransaction(async (client) => {
    const ride = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]),
    );
    if (!ride) throw notFound("Ride not found");

    const vehicle = await requireVehicleForDriver(actorId);
    if (ride.vehicle_id !== vehicle?.id) throw forbidden("Not your ride");

    const request = firstOrNull(
      await client.query<RideRequestRow>(
        `SELECT * FROM ride_requests WHERE id = $1 AND ride_id = $2 FOR UPDATE`,
        [requestId, rideId],
      ),
    );
    if (!request) throw notFound("That rider is not on this ride");
    if (request.status === "COMPLETED") return { ride: serializeRide(ride), request: serializeRequest(request), rideCompleted: ride.status === "COMPLETED" };
    if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
      throw conflict("RIDE_NOT_ACTIVE", "This ride is no longer running");
    }
    if (ride.status !== "STARTED") {
      throw conflict("RIDE_NOT_STARTED", "Start the trip before dropping anyone off");
    }

    await client.query(
      `UPDATE ride_requests SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
      [requestId],
    );
    await logEvent(client, { rideId, requestId, event: "COMPLETED", actorId });
    await settleIfOwed(client, rideId, requestId);

    // If that was the last rider, the ride is over too.
    const left = await client.query(
      `SELECT 1 FROM ride_requests
       WHERE ride_id = $1 AND status IN ('MATCHED','DRIVER_ARRIVED','STARTED') LIMIT 1`,
      [rideId],
    );
    const rideCompleted = rowsAffected(left) === 0;
    if (rideCompleted) {
      await client.query(
        `UPDATE rides SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
        [rideId],
      );
    }

    const freshRequest = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [requestId]),
    );
    const freshRide = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (!freshRequest || !freshRide) throw new Error("ride or request vanished mid drop-off");

    return {
      ride: serializeRide(freshRide),
      request: serializeRequest(freshRequest),
      rideCompleted,
    };
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

/** Pending REQUESTED requests grouped greedily by shared legs (poolable). */
export async function pendingPoolGroups(): Promise<PoolGroup[]> {
  const { rows } = await query<RideRequestWithNameRow>(
    `SELECT r.*, u.name AS passenger_name FROM ride_requests r
     JOIN users u ON u.id = r.passenger_id
     WHERE r.status = 'REQUESTED' ORDER BY r.created_at`,
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
  const groups = await pendingPoolGroups();

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
         AND (
              status IN ('REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED')
              -- The grace window exists so a *finished* ride keeps its rating
              -- and per-leg breakdown reachable for a moment. A cancelled ride
              -- is over the moment it is cancelled: leaving it here made it
              -- linger on screen, and the 2.5s poll kept resurrecting it.
              OR (status = 'COMPLETED' AND updated_at > now() - interval '5 minutes')
            )
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
      const { rows: crew } = await query<{ stop_ids: string[] }>(
        `SELECT stop_ids FROM ride_requests
         WHERE ride_id = $1 AND status IN ('MATCHED','DRIVER_ARRIVED','STARTED','COMPLETED')
         ORDER BY created_at`,
        [ride.id],
      );
      result.routeStopIds = orderedRoute(crew.map((r) => r.stop_ids));

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
