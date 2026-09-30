import { Router } from "express";
import { z } from "zod";
import { firstOrNull, query, rowsAffected, withTransaction } from "../../shared/db.js";
import { asyncHandler, badRequest, conflict, notFound } from "../../shared/errors.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { config } from "../../config/index.js";
import {
  legIdsBetween,
  logEvent,
  orderedRoute,
  recomputeRideFares,
  serializeRequest,
} from "./rides.service.js";
import { param } from "../../shared/http.js";
import type { RideRequestRow, RideRow, RideStatus } from "../../shared/types.js";

/**
 * Hop-on: a passenger boards a ride that is already running.
 *
 * This is the other half of pooling. `POST /rides/:id/join` is the *driver*
 * pulling a pending request into their trip; this is a *passenger* seeing a
 * Tesla heading their way and getting on at a stop the trip has not reached
 * yet. The seat is claimed with the same atomic conditional update the driver
 * path uses (PRD §11), so two passengers grabbing the last seat cannot both
 * win.
 */
export const openRidesRouter = Router();

const hopOnSchema = z.object({
  /** A stop on the trip that has not been passed yet. */
  pickupStopId: z.string().min(1),
  dropStopId: z.string().min(1),
  seats: z.number().int().min(1).max(3).default(1),
  waitAndSave: z.boolean().default(false),
  paymentMethod: z.enum(["CASH", "WALLET"]).default("CASH"),
});

/**
 * Rides with a seat free that this caller could still board, newest first.
 *
 * Each entry lists the stops the trip has already passed alongside the ones
 * still ahead, so the client can offer "get on at X" without re-deriving
 * where the vehicle is.
 */
openRidesRouter.get(
  "/rides/open",
  authenticate,
  requireRole("passenger"),
  asyncHandler(async (req, res) => {
    const rides = await listOpenRides(req.user.id);
    res.json({ rides });
  }),
);

openRidesRouter.post(
  "/rides/:id/hop-on",
  authenticate,
  requireRole("passenger"),
  rateLimit({
    max: config.rateLimit.rideRequestsMax,
    windowMs: config.rateLimit.rideRequestsWindowMs,
    keyOf: (req) => `hopon:${req.user.id}`,
  }),
  asyncHandler(async (req, res) => {
    const body = hopOnSchema.parse(req.body);
    const result = await hopOnRide({
      rideId: param(req, "id"),
      passengerId: req.user.id,
      pickupStopId: body.pickupStopId,
      dropStopId: body.dropStopId,
      seats: body.seats,
      waitAndSave: body.waitAndSave,
      paymentMethod: body.paymentMethod,
    });
    res.status(201).json(result);
  }),
);

/** Shape the API returns for one boardable ride. */
export interface OpenRide {
  rideId: string;
  status: string;
  seatsFree: number;
  capacity: number;
  vehicleName: string;
  driverName: string;
  /** Ordered stops the whole trip runs through. */
  routeStopIds: string[];
  /** Stops still ahead of the vehicle — valid pickup points. */
  aheadStopIds: string[];
  /** Where the vehicle is right now, as a position along routeStopIds. */
  departedCount: number;
  /** Per-stop rider count, so the UI can show who is already aboard. */
  occupancy: { stopId: string; riders: number }[];
  /**
   * Who is already on board. First name and destination only — the same
   * privacy boundary the co-rider payload uses (PRD §5): enough to decide
   * whether to get on, nothing more.
   */
  riders: { firstName: string; dropStopId: string }[];
  /** When the trip entered STARTED, so the client can animate its position. */
  startedAt: string | null;
}

const ACTIVE = "('MATCHED', 'DRIVER_ARRIVED', 'STARTED')";

export async function listOpenRides(passengerId: string): Promise<OpenRide[]> {
  const { rows } = await query<{
    ride_id: string;
    status: RideStatus;
    seats_taken: number;
    capacity: number;
    vehicle_name: string;
    driver_name: string;
    started_at: Date | null;
  }>(
    `SELECT r.id AS ride_id, r.status, r.seats_taken, r.capacity,
            v.name AS vehicle_name, u.name AS driver_name, r.updated_at AS started_at
     FROM rides r
     JOIN vehicles v ON v.id = r.vehicle_id
     JOIN users u ON u.id = v.driver_id
     WHERE r.status IN ${ACTIVE}
       AND r.seats_taken < r.capacity
       AND NOT EXISTS (
         SELECT 1 FROM ride_requests mine
         WHERE mine.passenger_id = $1 AND mine.ride_id = r.id
           AND mine.status IN ('REQUESTED','MATCHED','DRIVER_ARRIVED','STARTED')
       )
     ORDER BY r.created_at DESC`,
    [passengerId],
  );

  if (rows.length === 0) return [];

  const rideIds = rows.map((r) => r.ride_id);
  const members = await membersFor(rideIds);

  return rows.map((row) => {
    const crew = members.get(row.ride_id) ?? [];
    const routeStopIds = orderedRoute(crew.map((m) => m.stop_ids));

    // Where the vehicle has got to. Before the trip starts nobody has boarded,
    // so the whole route is ahead; once STARTED it has left the earliest
    // pickup on board, which is the demo's whole notion of "passed".
    const departedCount =
      row.status === "STARTED"
        ? earliestPickupIndex(crew, routeStopIds)
        : 0;

    return {
      rideId: row.ride_id,
      status: row.status,
      seatsFree: row.capacity - row.seats_taken,
      capacity: row.capacity,
      vehicleName: row.vehicle_name,
      driverName: row.driver_name,
      routeStopIds,
      aheadStopIds: routeStopIds.slice(departedCount),
      departedCount,
      occupancy: occupancyFor(crew, routeStopIds),
      riders: crew.map((m) => ({
        firstName: (m.passenger_name ?? "").split(" ")[0] ?? "",
        dropStopId: m.stop_ids.at(-1) ?? "",
      })),
      startedAt: row.started_at ? row.started_at.toISOString() : null,
    };
  });
}

interface CrewMember {
  passenger_id: string;
  passenger_name: string;
  pickup_stop: string;
  stop_ids: string[];
  status: string;
}

async function membersFor(rideIds: readonly string[]): Promise<Map<string, CrewMember[]>> {
  const out = new Map<string, CrewMember[]>();
  for (const id of rideIds) {
    const { rows } = await query<CrewMember>(
      `SELECT rq.passenger_id, rq.pickup_stop, rq.stop_ids, rq.status,
              u.name AS passenger_name
       FROM ride_requests rq
       JOIN users u ON u.id = rq.passenger_id
       WHERE rq.ride_id = $1
         AND rq.status IN ('MATCHED','DRIVER_ARRIVED','STARTED','COMPLETED')
       ORDER BY rq.created_at`,
      [id],
    );
    out.set(id, rows);
  }
  return out;
}

/** Index of the earliest pickup on board — i.e. where the auto set off from. */
function earliestPickupIndex(
  crew: readonly CrewMember[],
  route: readonly string[],
): number {
  let earliest = route.length;
  for (const member of crew) {
    const i = route.indexOf(member.pickup_stop);
    if (i !== -1 && i < earliest) earliest = i;
  }
  // Keep at least the next stop bookable, so a one-stop ride is still joinable.
  return Math.min(earliest, Math.max(0, route.length - 2));
}

function occupancyFor(
  crew: readonly CrewMember[],
  routeStopIds: readonly string[],
): { stopId: string; riders: number }[] {
  const counts = new Map<string, number>();
  for (const member of crew) {
    // The drop end is where the seat is occupied.
    const drop = member.stop_ids.at(-1);
    if (drop) counts.set(drop, (counts.get(drop) ?? 0) + 1);
  }
  return routeStopIds.map((stopId) => ({ stopId, riders: counts.get(stopId) ?? 0 }));
}

/**
 * Board a running ride at a stop it has not reached yet.
 *
 * The pickup must lie on the trip's remaining route and the drop must be
 * further along it — otherwise "hop on" is meaningless.
 */
export async function hopOnRide({
  rideId,
  passengerId,
  pickupStopId,
  dropStopId,
  seats,
  waitAndSave,
  paymentMethod = "CASH",
}: {
  rideId: string;
  passengerId: string;
  pickupStopId: string;
  dropStopId: string;
  seats: number;
  waitAndSave: boolean;
  paymentMethod?: "CASH" | "WALLET";
}) {
  if (pickupStopId === dropStopId) throw badRequest("Pickup and destination must differ");

  const open = (await listOpenRides(passengerId)).find((r) => r.rideId === rideId);
  if (!open) throw conflict("RIDE_NOT_OPEN", "That ride is full or no longer running");

  const ahead = open.aheadStopIds;
  const boardAt = ahead.indexOf(pickupStopId);
  if (boardAt === -1) {
    throw conflict("STOP_ALREADY_PASSED", "That stop is behind the auto — pick one ahead of it");
  }
  const dropAt = ahead.indexOf(dropStopId);
  if (dropAt === -1 || dropAt <= boardAt) {
    throw badRequest("Your destination must be further along the same trip");
  }

  const legIds = legIdsBetween(ahead, boardAt, dropAt);

  return withTransaction(async (client) => {
    const ride = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]),
    );
    if (!ride) throw notFound("Ride not found");

    const { priceLegs, BASE_FARE_PAISA } = await import("../../graph/index.js");
    const { edgeByLegId } = await import("../../graph/index.js");

    // One active ride per passenger, same guard as POST /rides/request.
    const active = await client.query(
      `SELECT 1 FROM ride_requests
       WHERE passenger_id = $1 AND status IN ('REQUESTED','MATCHED','DRIVER_ARRIVED','STARTED')
       LIMIT 1`,
      [passengerId],
    );
    if (rowsAffected(active) > 0) {
      throw conflict("ACTIVE_RIDE_EXISTS", "You already have a ride in progress");
    }

    const row = firstOrNull(
      await client.query<RideRequestRow>(
        `INSERT INTO ride_requests
          (passenger_id, ride_id, pickup_stop, drop_stop, route_id, leg_ids, stop_ids, seats, status,
           base_fare_paisa, distance_charge_paisa, pool_discount_paisa, wait_save_discount_paisa,
           total_fare_paisa, wait_and_save, payment_method)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8,
                 $9, 0, 0, 0, $9, $10, $11)
         RETURNING *`,
        [
          passengerId,
          rideId,
          pickupStopId,
          dropStopId,
          legIds,
          ahead.slice(boardAt, dropAt + 1),
          seats,
          // Boarding a moving car means starting at that stage, not MATCHED.
          ride.status,
          BASE_FARE_PAISA,
          waitAndSave,
          paymentMethod,
        ],
      ),
    );
    if (!row) throw new Error("hop-on insert returned no row");

    // The same atomic claim as every other seat: 1 row = seated, 0 = full.
    const claim = await client.query(
      `UPDATE rides SET seats_taken = seats_taken + $2, updated_at = now()
       WHERE id = $1 AND seats_taken + $2 <= capacity`,
      [rideId, seats],
    );
    if (rowsAffected(claim) === 0) {
      throw conflict("RIDE_FULL", "That seat was just taken — pick another ride");
    }

    // Fare is provisional here; recomputeRideFares prices it with everyone on board.
    const provisional = priceLegs(legIds.map(edgeByLegId), {}, waitAndSave);
    await client.query(
      `UPDATE ride_requests
       SET distance_charge_paisa = $2, pool_discount_paisa = $3,
           wait_save_discount_paisa = $4, total_fare_paisa = $5
       WHERE id = $1`,
      [row.id, provisional.distanceCharge, provisional.poolDiscount,
       provisional.waitSaveDiscount, provisional.total],
    );

    await recomputeRideFares(client, rideId);
    await logEvent(client, { rideId, requestId: row.id, event: "JOINED", actorId: passengerId });

    const fresh = firstOrNull(
      await client.query<RideRequestRow>("SELECT * FROM ride_requests WHERE id = $1", [row.id]),
    );
    const freshRide = firstOrNull(
      await client.query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]),
    );
    if (!fresh || !freshRide) throw new Error("ride or request vanished mid hop-on");

    return {
      ride: {
        id: freshRide.id,
        status: freshRide.status,
        seatsTaken: freshRide.seats_taken,
        capacity: freshRide.capacity,
      },
      request: serializeRequest(fresh, []),
    };
  });
}

export { hopOnSchema };