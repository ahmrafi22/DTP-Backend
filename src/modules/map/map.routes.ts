import { Router } from "express";
import { asyncHandler } from "../../shared/errors.js";
import { query } from "../../shared/db.js";
import { logger } from "../../shared/logger.js";
import { ACTIVE_RIDE_STATUSES } from "../rides/rides.constants.js";
import type {
  MapLiveDriver,
  MapLivePayload,
  MapLiveRide,
  RequestStatus,
  RideRow,
  RideRequestRow,
} from "../../shared/types.js";

export const mapRouter = Router();

/**
 * The whole living fleet in ONE call: every driver with phase, position
 * inputs and (for running trips) the passenger list — first name + get-off
 * stop only, never a fare. The map polls this; nothing else exists for it.
 *
 * A 1-second in-memory cache collapses concurrent pollers into one set of
 * queries — N tabs cost the same as one tab.
 */

interface LiveDriverRow {
  driver_id: string;
  driver_name: string;
  is_online: boolean;
  vehicle_id: string;
  vehicle_name: string;
  capacity: number;
  base_stop_id: string | null;
  color: string | null;
}

interface StartedEventRow {
  ride_id: string;
  at: Date;
}

interface LegDurationRow {
  id: string;
  duration_min: number;
}

interface Cache {
  at: number;
  payload: MapLivePayload;
}

let cache: Cache | null = null;
const CACHE_MS = 1000;

/**
 * Live state for ONE ride — the path, time-based progress and who is aboard.
 * Shared with the hop-on preview/join so boarding rules (which stops are
 * still reachable) agree with what the map shows.
 */
export async function liveRideFor(rideId: string): Promise<{ live: MapLiveRide | null }> {
  const rideRow = await query<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]);
  const ride = rideRow.rows[0];
  if (!ride || !ACTIVE_RIDE_STATUSES.includes(ride.status)) return { live: null };

  const memberRows = await query<RideRequestRow & { passenger_name: string }>(
    `SELECT r.*, u.name AS passenger_name FROM ride_requests r
     JOIN users u ON u.id = r.passenger_id
     WHERE r.ride_id = $1 AND r.status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')
     ORDER BY r.created_at`,
    [rideId],
  );
  const members = memberRows.rows;
  const primary = members[0];
  if (!primary && !(ride.stop_ids && ride.stop_ids.length >= 2)) return { live: null };

  const stopIds =
    ride.stop_ids && ride.stop_ids.length >= 2 ? ride.stop_ids : primary?.stop_ids ?? [];

  const pathLegIds = stopIds.reduce((ids: string[], stop, i) => {
    if (i === 0) return ids;
    const key = [stopIds[i - 1], stop].sort().join("~");
    if (!ids.includes(key)) ids.push(key);
    return ids;
  }, []);
  const legDurations = pathLegIds.length
    ? await query<LegDurationRow>(
        `SELECT id, duration_min FROM legs WHERE id = ANY($1::text[])`,
        [pathLegIds],
      )
    : { rows: [] as LegDurationRow[] };
  const totalSec = pathLegIds.reduce(
    (sum, id) => sum + (legDurations.rows.find((l) => l.id === id)?.duration_min ?? 0),
    0,
  ) * 60;

  let progress = 0;
  if (ride.status === "STARTED" && totalSec > 0) {
    const started = await query<StartedEventRow>(
      `SELECT at FROM ride_events WHERE event = 'STARTED' AND ride_id = $1 ORDER BY at DESC LIMIT 1`,
      [rideId],
    );
    const startedAt = started.rows[0]?.at;
    const elapsedSec = startedAt ? Math.max(0, (Date.now() - startedAt.getTime()) / 1000) : 0;
    progress = Math.min(1, elapsedSec / totalSec);
  }

  return {
    live: {
      id: ride.id,
      status: ride.status,
      stopIds,
      progress,
      totalSec,
      passengers: members.map((m) => ({
        firstName: firstNameOf(m.passenger_name),
        dropStopId: m.drop_stop,
        status: m.status as RequestStatus,
      })),
    },
  };
}


/** First name for display — always a string, empty when the name is empty. */
function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? "";
}

export async function mapLive(): Promise<MapLivePayload> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.payload;

  const [driverRows, rideRows] = await Promise.all([
    query<LiveDriverRow>(
      `SELECT u.id AS driver_id, u.name AS driver_name, u.is_online,
              v.id AS vehicle_id, v.name AS vehicle_name, v.capacity,
              v.base_stop_id, v.color
       FROM vehicles v JOIN users u ON u.id = v.driver_id
       ORDER BY v.id`,
    ),
    query<RideRow>(
      `SELECT * FROM rides WHERE status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')`,
    ),
  ]);

  const activeRides = rideRows.rows;
  const rideIds = activeRides.map((r) => r.id);
  const startedRideIds = activeRides.filter((r) => r.status === "STARTED").map((r) => r.id);

  const [memberRows, startedRows] = await Promise.all([
    rideIds.length
      ? query<RideRequestRow & { passenger_name: string }>(
          `SELECT r.*, u.name AS passenger_name FROM ride_requests r
           JOIN users u ON u.id = r.passenger_id
           WHERE r.ride_id = ANY($1::text[])
             AND r.status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')
           ORDER BY r.created_at`,
          [rideIds],
        )
      : Promise.resolve({ rows: [] as (RideRequestRow & { passenger_name: string })[] }),
    startedRideIds.length
      ? query<StartedEventRow>(
          `SELECT DISTINCT ON (ride_id) ride_id, at FROM ride_events
           WHERE event = 'STARTED' AND ride_id = ANY($1::text[])
           ORDER BY ride_id, at DESC`,
          [startedRideIds],
        )
      : Promise.resolve({ rows: [] as StartedEventRow[] }),
  ]);

  // Trip duration for progress: the primary rider's legs define the path.
  const primaryByRide = new Map<string, RideRequestRow & { passenger_name: string }>();
  for (const row of memberRows.rows) {
    const existing = primaryByRide.get(row.ride_id ?? "");
    if (!existing || row.created_at < existing.created_at) {
      primaryByRide.set(row.ride_id ?? "", row);
    }
  }
  const pathByRide = new Map<string, string[]>();
  for (const ride of activeRides) {
    pathByRide.set(
      ride.id,
      ride.stop_ids && ride.stop_ids.length >= 2 ? ride.stop_ids : primaryByRide.get(ride.id)?.stop_ids ?? [],
    );
  }
  const legIdsOf = (stopIds: string[]): string[] => {
    const ids: string[] = [];
    for (let i = 1; i < stopIds.length; i += 1) {
      const a = stopIds[i - 1];
      const b = stopIds[i];
      if (a && b) ids.push([a, b].sort().join("~"));
    }
    return ids;
  };
  const pathLegIdsByRide = new Map<string, string[]>();
  const primaryLegIds: string[] = [];
  for (const [rideId, stopIds] of pathByRide) {
    const ids = legIdsOf(stopIds);
    pathLegIdsByRide.set(rideId, ids);
    primaryLegIds.push(...ids);
  }
  const legDurations = new Map<string, number>();
  if (primaryLegIds.length) {
    const { rows } = await query<LegDurationRow>(
      `SELECT id, duration_min FROM legs WHERE id = ANY($1::text[])`,
      [primaryLegIds],
    );
    for (const row of rows) legDurations.set(row.id, row.duration_min);
  }

  const startedAtByRide = new Map<string, Date>();
  for (const row of startedRows.rows) startedAtByRide.set(row.ride_id, row.at);

  const rideByVehicle = new Map<string, RideRow>();
  for (const ride of activeRides) rideByVehicle.set(ride.vehicle_id, ride);

  const membersByRide = new Map<string, (RideRequestRow & { passenger_name: string })[]>();
  for (const row of memberRows.rows) {
    const list = membersByRide.get(row.ride_id ?? "") ?? [];
    list.push(row);
    membersByRide.set(row.ride_id ?? "", list);
  }

  const now = Date.now();
  const drivers: MapLiveDriver[] = driverRows.rows.map((row) => {
    const ride = rideByVehicle.get(row.vehicle_id);
    let live: MapLiveRide | null = null;
    if (ride) {
      const members = membersByRide.get(ride.id) ?? [];
      const totalSec = (pathLegIdsByRide.get(ride.id) ?? []).reduce(
        (sum, id) => sum + (legDurations.get(id) ?? 0),
        0,
      ) * 60;
      const startedAt = startedAtByRide.get(ride.id);
      const elapsedSec = startedAt ? Math.max(0, (now - startedAt.getTime()) / 1000) : 0;
      const progress =
        ride.status === "STARTED" && totalSec > 0
          ? Math.min(1, elapsedSec / totalSec)
          : 0;
      live = {
        id: ride.id,
        status: ride.status,
        stopIds: pathByRide.get(ride.id) ?? [],
        progress,
        totalSec,
        passengers: members.map((m) => ({
          firstName: firstNameOf(m.passenger_name),
          dropStopId: m.drop_stop,
          status: m.status as RequestStatus,
        })),
      };
    }

    return {
      driverId: row.driver_id,
      driverName: row.driver_name,
      vehicleId: row.vehicle_id,
      vehicleName: row.vehicle_name,
      color: row.color,
      online: row.is_online,
      phase: ride ? "onboard" : row.is_online ? "waiting" : "offline",
      baseStopId: row.base_stop_id,
      seatsTaken: ride?.seats_taken ?? 0,
      capacity: row.capacity,
      ride: live,
    };
  });

  const payload: MapLivePayload = { drivers, serverTime: new Date().toISOString() };
  cache = { at: Date.now(), payload };
  return payload;
}

mapRouter.get(
  "/map/live",
  asyncHandler(async (_req, res) => {
    try {
      res.json(await mapLive());
    } catch (err) {
      logger.error("map_live_failed", { error: (err as Error).message });
      throw err;
    }
  }),
);

