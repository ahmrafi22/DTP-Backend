import "./env.js";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { reseed, cleanup, resetRateLimits, get, post, registerPassenger } from "./helpers.js";
import { runShuttleTick } from "../src/modules/map/shuttle.js";
import { query } from "../src/shared/db.js";

beforeEach(async () => {
  await reseed();
  resetRateLimits();
});
afterAll(cleanup);

interface ShuttleRideRow {
  id: string;
  vehicle_id: string;
  seats_taken: number;
  capacity: number;
}

async function activeShuttleRides(): Promise<ShuttleRideRow[]> {
  const { rows } = await query<ShuttleRideRow>(
    `SELECT r.id, r.vehicle_id, r.seats_taken, r.capacity FROM rides r
     JOIN vehicles v ON v.id = r.vehicle_id
     WHERE v.corridor_route_id IS NOT NULL
       AND r.status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')`,
  );
  return rows;
}

describe("auto-shuttles (the always-running map)", () => {
  it("keeps up to three random autos running with legal occupancy and real riders", async () => {
    await runShuttleTick();
    const rides = await activeShuttleRides();
    expect(rides.length).toBeGreaterThanOrEqual(1);
    expect(rides.length).toBeLessThanOrEqual(3);

    let memberCount = 0;
    for (const ride of rides) {
      expect(ride.seats_taken).toBeLessThanOrEqual(ride.capacity);
      const { rows } = await query<{ count: string }>(
        `SELECT count(*) FROM ride_requests WHERE ride_id = $1 AND status = 'MATCHED'`,
        [ride.id],
      );
      memberCount += Number(rows[0]?.count ?? 0);
      // every trip is STARTED so the map's time-based progress runs
      const started = await query(
        `SELECT 1 FROM ride_events WHERE ride_id = $1 AND event = 'STARTED'`,
        [ride.id],
      );
      expect(started.rowCount).toBe(1);
    }
    // seats_taken is real membership, not a ghost counter
    expect(memberCount).toBe(rides.reduce((sum, r) => sum + r.seats_taken, 0));
  });

  it("completes elapsed trips into history and the driver cycles again", async () => {
    await runShuttleTick();
    const first = await activeShuttleRides();
    expect(first.length).toBeGreaterThan(0);

    // The path time has passed: backdate the STARTED events.
    await query(`UPDATE ride_events SET at = now() - interval '2 hours' WHERE event = 'STARTED'`);
    await runShuttleTick();

    const { rows: completed } = await query<{ count: string }>(
      `SELECT count(DISTINCT ride_id) FROM ride_requests WHERE status = 'COMPLETED' AND ride_id IN (SELECT id FROM rides WHERE status = 'COMPLETED')`,
    );
    expect(Number(completed[0]?.count ?? 0)).toBeGreaterThanOrEqual(first.length);

    // The freed shuttles (after dwell) or others keep the map running.
    const second = await activeShuttleRides();
    expect(second.length).toBeGreaterThanOrEqual(1);
    expect(second.length).toBeLessThanOrEqual(3);
  });

  it("lets a passenger hop into a running shuttle at the trip's stops", async () => {
    await runShuttleTick();
    const rides = await activeShuttleRides();
    const target = rides[0];
    if (!target) throw new Error("no shuttle running");

    // Guarantee a free seat for a deterministic join.
    await query(`UPDATE rides SET seats_taken = 1 WHERE id = $1`, [target.id]);

    const path = (
      await query<{ stop_ids: string[] | null }>(
        `SELECT stop_ids FROM rides WHERE id = $1`,
        [target.id],
      )
    ).rows[0]?.stop_ids;
    if (!path || path.length < 2) throw new Error("shuttle has no path");

    const joiner = await registerPassenger("Hop On");
    const preview = await get(
      `/rides/${target.id}/preview?pickupStopId=${path[0]}&dropStopId=${path[path.length - 1]}`,
      joiner.token,
    );
    expect(preview.status).toBe(200);
    expect(preview.data.stops[0]).toBe(path[0]);

    const join = await post(
      `/rides/${target.id}/join`,
      { pickupStopId: path[0], dropStopId: path[path.length - 1] },
      joiner.token,
    );
    expect(join.status).toBe(201);
    expect(join.data.request.status).toBe("MATCHED");

    const { rows } = await query<{ seats_taken: number }>(
      "SELECT seats_taken FROM rides WHERE id = $1",
      [target.id],
    );
    expect(rows[0]?.seats_taken).toBe(2);
  });
});
