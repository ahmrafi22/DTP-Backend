import { query, withTransaction } from "../../shared/db.js";
import { logger } from "../../shared/logger.js";
import { ROUTE_MAP, getEdge, priceLegs } from "../../graph/index.js";
import type { Edge, RidersPerLeg } from "../../graph/index.js";
import type { RideRow } from "../../shared/types.js";
import { liveRideFor } from "./map.routes.js";

/**
 * Auto-shuttles: the heartbeat of the map.
 *
 * Every fleet auto has a home corridor. The scheduler keeps a small RANDOM
 * set of them running at any time — each tick tops up to the target by
 * picking random idle drivers, so who is driving changes all day long. They
 * board a band-dependent number of regular commuters on random slices of the
 * path (rush hours fill up, late nights run emptier), run the trip to the
 * end, complete it into history, dwell a moment, and may go again.
 *
 * All of it is real rows — the passengers aboard, the fares, the history —
 * and everything is hop-on-able while a seat is free.
 */

const TICK_MS = 15_000;
/** How many autos should be running at once (randomly re-drawn as they cycle). */
const TARGET_RUNNING = 3;

let timer: ReturnType<typeof setInterval> | null = null;
/** Alternate direction per cycle so a shuttle ping-pongs its corridor. */
const lastDirection = new Map<string, 1 | -1>();
/** Short dwell at the corridor end between two cycles. */
const dwellUntil = new Map<string, number>();

export function startShuttleScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runShuttleTick().catch((err: unknown) => {
      logger.error("shuttle_tick_failed", { error: (err as Error).message });
    });
  }, TICK_MS);
  logger.info("shuttle_scheduler_started", { tickMs: TICK_MS, targetRunning: TARGET_RUNNING });
}

export function stopShuttleScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

interface ShuttleVehicle {
  vehicle_id: string;
  driver_id: string;
  corridor_route_id: string;
}

/**
 * One pass: finish trips whose path time has elapsed, then top up to the
 * target with randomly chosen idle shuttles.
 */
export async function runShuttleTick(): Promise<void> {
  const { rows: shuttles } = await query<ShuttleVehicle>(
    `SELECT v.id AS vehicle_id, v.driver_id, v.corridor_route_id FROM vehicles v
     WHERE v.corridor_route_id IS NOT NULL`,
  );
  if (shuttles.length === 0) return;

  // 1. Complete anything whose time on the path is up.
  const { rows: active } = await query<RideRow>(
    `SELECT * FROM rides WHERE status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')
     AND vehicle_id = ANY($1::text[])`,
    [shuttles.map((s) => s.vehicle_id)],
  );
  const driverByVehicle = new Map(shuttles.map((s) => [s.vehicle_id, s.driver_id]));
  for (const ride of active) {
    const { live } = await liveRideFor(ride.id);
    if (live && live.progress >= 1) {
      await completeShuttleRide(ride.id, ride.vehicle_id, driverByVehicle.get(ride.vehicle_id) ?? "");
    }
  }

  // 2. Recount and top up with random idle shuttles.
  const busyVehicles = new Set(
    (await query<{ vehicle_id: string }>(
      `SELECT vehicle_id FROM rides WHERE status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')
       AND vehicle_id = ANY($1::text[])`,
      [shuttles.map((s) => s.vehicle_id)],
    )).rows.map((r) => r.vehicle_id),
  );
  const now = Date.now();
  const idle = shuttles.filter(
    (s) => !busyVehicles.has(s.vehicle_id) && (dwellUntil.get(s.vehicle_id) ?? 0) <= now,
  );
  // Fisher–Yates on the idle set: who runs is random, not rostered.
  for (let i = idle.length - 1; i > 0; i -= 1) {
    const swap = Math.floor(Math.random() * (i + 1));
    const a = idle[i];
    const b = idle[swap];
    if (a === undefined || b === undefined) continue;
    idle[i] = b;
    idle[swap] = a;
  }

  const toStart = Math.min(TARGET_RUNNING - busyVehicles.size, idle.length);
  for (let i = 0; i < toStart; i += 1) {
    const shuttle = idle[i];
    if (!shuttle) break;
    try {
      await startShuttleTrip(shuttle.vehicle_id, shuttle.driver_id, shuttle.corridor_route_id);
    } catch (err) {
      logger.error("shuttle_start_failed", {
        vehicle: shuttle.vehicle_id,
        error: (err as Error).message,
      });
    }
  }
}

/** BD minutes-of-day, via Intl (the server may run in any timezone). */
function bdMinutes(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Occupancy weights by time band: rush hours fill, late night runs empty. */
function pickOccupancy(bdMin: number, capacity: number): number {
  const rush = (bdMin >= 480 && bdMin < 600) || (bdMin >= 960 && bdMin < 1200);
  const night = bdMin < 300 || bdMin >= 1380;
  const roll = Math.random();
  if (night) return roll < 0.5 ? 0 : 1;
  if (rush) return roll < 0.3 ? 1 : roll < 0.75 ? 2 : capacity;
  return roll < 0.3 ? 0 : roll < 0.75 ? 1 : 2;
}

function pick<T>(items: T[]): T {
  const choice = items[Math.floor(Math.random() * items.length)];
  if (choice === undefined) throw new Error("pick() from an empty list");
  return choice;
}

/**
 * Start one shuttle cycle: random direction, board 0–capacity regular
 * commuters on random slices of the path (band-dependent), mark the trip
 * STARTED so the map's time-based progress begins immediately.
 */
export async function startShuttleTrip(
  vehicleId: string,
  driverId: string,
  routeId: string,
): Promise<string> {
  const route = ROUTE_MAP.get(routeId);
  if (!route) throw new Error(`Shuttle corridor ${routeId} missing from the graph`);

  const previous = lastDirection.get(vehicleId) ?? (Math.random() < 0.5 ? 1 : -1);
  const direction: 1 | -1 = previous === 1 ? -1 : 1;
  lastDirection.set(vehicleId, direction);

  const path = direction === 1 ? [...route.stops] : [...route.stops].reverse();

  // Board commuters whose home stop lies on this path; each rides a random
  // slice, so shared-leg discounts vary leg by leg.
  const { rows: commuters } = await query<{ id: string; home_stop_id: string | null }>(
    `SELECT id, home_stop_id FROM users
     WHERE role = 'passenger' AND id NOT IN ('nusrat', 'rafiq', 'shirin')`,
  );
  const onPath = commuters.filter((c) => c.home_stop_id && path.includes(c.home_stop_id));

  const bdMin = bdMinutes();
  const wanted = pickOccupancy(bdMin, 3);
  const boarded: { passengerId: string; legs: Edge[]; stopIds: string[] }[] = [];
  const usedPassengers = new Set<string>();

  for (let seat = 0; seat < wanted && onPath.length > 0; seat += 1) {
    const candidates = onPath.filter((c) => !usedPassengers.has(c.id));
    if (candidates.length === 0) break;
    const rider = pick(candidates);
    usedPassengers.add(rider.id);

    // Board at home — unless home is the terminus this direction, then the
    // rider simply waits for the opposite run.
    const getInCandidates = path
      .map((stop, i) => (stop === rider.home_stop_id ? i : -1))
      .filter((i) => i >= 0 && i < path.length - 1);
    if (getInCandidates.length === 0) continue;
    const getIn = pick(getInCandidates);
    const laterStops = path.slice(getIn + 1);
    if (laterStops.length === 0) continue;
    const getOut = getIn + 1 + Math.floor(Math.random() * laterStops.length);

    const legs: Edge[] = [];
    for (let i = getIn; i < getOut; i += 1) {
      const from = path[i];
      const to = path[i + 1];
      if (!from || !to) continue;
      const leg = getEdge(from, to);
      if (leg) legs.push(leg);
    }
    if (legs.length === 0) continue;
    boarded.push({
      passengerId: rider.id,
      legs,
      stopIds: path.slice(getIn, getOut + 1),
    });
  }

  return withTransaction(async (client) => {
    // Re-check inside the transaction: no active ride for this vehicle.
    const busy = await client.query(
      `SELECT 1 FROM rides WHERE vehicle_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED') LIMIT 1`,
      [vehicleId],
    );
    if (busy.rowCount && busy.rowCount > 0) {
      return "";
    }

    const ridersPerLeg: RidersPerLeg = {};
    for (const rider of boarded) {
      for (const leg of rider.legs) {
        ridersPerLeg[leg.id] = (ridersPerLeg[leg.id] ?? 0) + 1;
      }
    }

    // A shuttle on the road is, by definition, online.
    await client.query(`UPDATE users SET is_online = true WHERE id = $1`, [driverId]);
    const { rows: rideRows } = await client.query<{ id: string }>(
      `INSERT INTO rides (vehicle_id, status, seats_taken, capacity, stop_ids)
       VALUES ($1, 'MATCHED', $2, 3, $3) RETURNING id`,
      [vehicleId, boarded.length, path],
    );
    const rideId = rideRows[0]?.id;
    if (!rideId) throw new Error("Shuttle ride INSERT produced no id");

    for (const rider of boarded) {
      const fare = priceLegs(rider.legs, ridersPerLeg);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ride_requests
          (passenger_id, ride_id, pickup_stop, drop_stop, route_id, leg_ids, stop_ids, seats,
           status, base_fare_paisa, distance_charge_paisa, pool_discount_paisa, total_fare_paisa)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'MATCHED', $8, $9, $10, $11)
         RETURNING id`,
        [
          rider.passengerId, rideId,
          rider.stopIds[0], rider.stopIds[rider.stopIds.length - 1], routeId,
          rider.legs.map((l) => l.id), rider.stopIds,
          fare.baseFare, fare.distanceCharge, fare.poolDiscount, fare.total,
        ],
      );
      const requestId = inserted.rows[0]?.id;
      if (!requestId) throw new Error("Shuttle member INSERT produced no id");
      for (const [i, line] of fare.lines.entries()) {
        await client.query(
          `INSERT INTO fare_legs
            (request_id, leg_no, leg_id, from_stop, to_stop, riders_on_leg, discount_pct, price_paisa, paid_paisa)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [requestId, i, line.edgeId, line.from, line.to, line.riders, line.discountPct, line.pricePaisa, line.paidPaisa],
        );
      }
      await client.query(
        `INSERT INTO ride_events (ride_id, request_id, event, actor_id) VALUES ($1, $2, 'REQUEST_CREATED', $3)`,
        [rideId, requestId, rider.passengerId],
      );
    }

    const now = new Date();
    for (const event of ["MATCHED", "DRIVER_ARRIVED", "STARTED"]) {
      await client.query(
        `INSERT INTO ride_events (ride_id, event, actor_id, at) VALUES ($1, $2, $3, $4)`,
        [rideId, event, driverId, now],
      );
    }
    // The ride itself reaches STARTED: progress and completion key off it.
    await client.query(
      `UPDATE rides SET status = 'STARTED', updated_at = now() WHERE id = $1`,
      [rideId],
    );

    logger.info("shuttle_trip_started", {
      vehicle: vehicleId,
      ride: rideId,
      riders: boarded.length,
      direction,
      path: path.join(">"),
    });
    return rideId;
  });
}

/** Close a finished shuttle cycle: riders complete, driver dwells, then goes again. */
export async function completeShuttleRide(
  rideId: string,
  vehicleId: string,
  driverId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE rides SET status = 'COMPLETED', updated_at = now()
       WHERE id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')`,
      [rideId],
    );
    if (!rowCount) return;
    await client.query(
      `UPDATE ride_requests SET status = 'COMPLETED', updated_at = now()
       WHERE ride_id = $1 AND status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')`,
      [rideId],
    );
    await client.query(
      `INSERT INTO ride_events (ride_id, event, actor_id) VALUES ($1, 'COMPLETED', $2)`,
      [rideId, driverId],
    );
  });
  dwellUntil.set(vehicleId, Date.now() + 20_000 + Math.random() * 40_000);
  logger.info("shuttle_trip_completed", { vehicle: vehicleId, ride: rideId });
}
