import bcrypt from "bcryptjs";
import { pathToFileURL } from "node:url";
import { pool } from "../shared/db.js";
import { config } from "../config/index.js";
import { logger } from "../shared/logger.js";
import { EDGES, NODES, ROUTES, legsBetween, priceLegs } from "../graph/index.js";
import type { Edge, LegFare } from "../graph/index.js";
import type { DbClient } from "../shared/db.js";

/**
 * Reset + seed the demo world (PRD cast): Jashim & Bullet, Nusrat, Rafiq,
 * Shirin, plus Kabir & Rocket and an admin. Also loads the predefined Dhaka
 * graph and a little completed/cancelled history so screens have content.
 *
 * Idempotent: truncates everything, then reinserts. Bulk inserts keep this
 * fast over the network (Neon) so tests can reset cheaply.
 */

export const DEMO_PASSWORD = "demo1234";

/** One multi-row INSERT per call instead of one per row. */
async function bulkInsert(
  client: DbClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  if (rows.length === 0) return;

  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((row, r) => {
      const placeholders = row.map((_, c) => `$${r * columns.length + c + 1}`);
      values.push(`(${placeholders.join(", ")})`);
      params.push(...row);
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values.join(", ")}`,
      params,
    );
  }
}

interface SeedUser {
  id: string;
  name: string;
  phone: string;
  role: string;
  home: string | null;
  online: boolean;
}

/** The two pooled riders on R05, priced exactly as the pool engine would. */
function pooledDemoFares(): {
  nusratLegs: Edge[];
  rafiqLegs: Edge[];
  nusratFare: LegFare;
  rafiqFare: LegFare;
} {
  const nusratLegs = legsBetween("R05", "banani", "mohakhali");
  const rafiqLegs = legsBetween("R05", "banani", "gulshan1");
  if (!nusratLegs || !rafiqLegs) throw new Error("Seed corridor R05 no longer connects Banani");

  const ridersPerLeg: Record<string, number> = {};
  for (const leg of [...nusratLegs, ...rafiqLegs]) {
    ridersPerLeg[leg.id] = (ridersPerLeg[leg.id] ?? 0) + 1;
  }
  return {
    nusratLegs,
    rafiqLegs,
    nusratFare: priceLegs(nusratLegs, ridersPerLeg),
    rafiqFare: priceLegs(rafiqLegs, ridersPerLeg),
  };
}

/** fare_legs rows for one request, numbered from zero. */
function fareLineRows(requestId: string, fare: LegFare): unknown[][] {
  return fare.lines.map((line, i) => [
    requestId,
    i,
    line.edgeId,
    line.from,
    line.to,
    line.riders,
    line.discountPct,
    line.pricePaisa,
    line.paidPaisa,
  ]);
}

export async function seed(): Promise<void> {
  const hash = await bcrypt.hash(DEMO_PASSWORD, config.bcryptRounds);
  const { nusratLegs, rafiqLegs, nusratFare, rafiqFare } = pooledDemoFares();
  const shirinLegs = legsBetween("R01", "uttara_hb", "mohakhali");
  if (!shirinLegs) throw new Error("Seed corridor R01 no longer connects Uttara to Mohakhali");
  const shirinFare = priceLegs(shirinLegs);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      TRUNCATE ride_events, fare_legs, ride_requests, rides,
               vehicles, users, route_stops, routes, legs, stops
      RESTART IDENTITY CASCADE
    `);

    // ---------- geography ----------
    await bulkInsert(
      client,
      "stops",
      ["id", "name", "zone", "lat", "lng"],
      Object.values(NODES).map((s) => [s.id, s.name, s.zone, s.lat, s.lng]),
    );
    await bulkInsert(
      client,
      "legs",
      ["id", "from_stop", "to_stop", "km", "congestion", "duration_min", "price_paisa"],
      EDGES.map((l) => [l.id, l.from, l.to, l.km, l.congestion, l.durationMin, l.pricePaisa]),
    );
    await bulkInsert(
      client,
      "routes",
      ["id", "name", "corridor"],
      ROUTES.map((r) => [r.id, r.name, r.corridor]),
    );
    await bulkInsert(
      client,
      "route_stops",
      ["route_id", "position", "stop_id"],
      ROUTES.flatMap((r) => r.stops.map((stopId, position) => [r.id, position, stopId])),
    );

    // ---------- cast ----------
    const users: SeedUser[] = [
      { id: "nusrat", name: "Nusrat", phone: "+880 171 0001001", role: "passenger", home: "banani", online: false },
      { id: "rafiq", name: "Rafiq", phone: "+880 171 0001002", role: "passenger", home: "banani", online: false },
      { id: "shirin", name: "Shirin", phone: "+880 171 0001003", role: "passenger", home: "gulshan1", online: false },
      { id: "jashim", name: "Jashim", phone: "+880 181 0002001", role: "driver", home: "banani", online: true },
      { id: "kabir", name: "Kabir", phone: "+880 181 0002002", role: "driver", home: "mohakhali", online: false },
      { id: "admin", name: "Demo Admin", phone: "+880 191 0009001", role: "admin", home: null, online: false },
    ];
    await bulkInsert(
      client,
      "users",
      ["id", "name", "phone", "password_hash", "role", "home_stop_id", "is_online"],
      users.map((u) => [u.id, u.name, u.phone, hash, u.role, u.home, u.online]),
    );
    await bulkInsert(client, "vehicles", ["id", "driver_id", "name", "capacity"], [
      ["bullet", "jashim", "Bullet", 3],
      ["rocket", "kabir", "Rocket", 3],
    ]);

    // ---------- history: the Nusrat + Rafiq pooled trip, two days ago ----------
    const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
    const at2d = daysAgo(2);

    await client.query(
      `INSERT INTO rides (id, vehicle_id, status, seats_taken, capacity, created_at, updated_at)
       VALUES ('ride-seed-1', 'bullet', 'COMPLETED', 2, 3, $1, $1)`,
      [at2d],
    );
    await bulkInsert(
      client,
      "ride_requests",
      [
        "id", "passenger_id", "ride_id", "pickup_stop", "drop_stop", "route_id", "leg_ids", "stop_ids",
        "seats", "status", "base_fare_paisa", "distance_charge_paisa", "pool_discount_paisa",
        "total_fare_paisa", "rating", "created_at", "updated_at",
      ],
      [
        [
          "req-seed-1", "nusrat", "ride-seed-1", "banani", "mohakhali", "R05",
          nusratLegs.map((l) => l.id), ["banani", "gulshan2", "gulshan1", "mohakhali"],
          1, "COMPLETED", nusratFare.baseFare, nusratFare.distanceCharge, nusratFare.poolDiscount,
          nusratFare.total, 5, at2d, at2d,
        ],
        [
          "req-seed-2", "rafiq", "ride-seed-1", "banani", "gulshan1", "R05",
          rafiqLegs.map((l) => l.id), ["banani", "gulshan2", "gulshan1"],
          1, "COMPLETED", rafiqFare.baseFare, rafiqFare.distanceCharge, rafiqFare.poolDiscount,
          rafiqFare.total, 4, at2d, at2d,
        ],
      ],
    );

    // ---------- history: Shirin's cancelled solo ride, yesterday ----------
    const at1d = daysAgo(1);
    await client.query(
      `INSERT INTO ride_requests
        (id, passenger_id, pickup_stop, drop_stop, route_id, leg_ids, stop_ids, seats, status,
         base_fare_paisa, distance_charge_paisa, pool_discount_paisa, total_fare_paisa, cancel_reason, created_at, updated_at)
       VALUES ('req-seed-3', 'shirin', 'uttara_hb', 'mohakhali', 'R01', $1, $2, 1, 'CANCELLED', $3, $4, $5, $6, 'Plans changed', $7, $7)`,
      [
        shirinLegs.map((l) => l.id),
        ["uttara_hb", "rajlakshmi", "airport", "kurmitola", "banani", "mohakhali"],
        shirinFare.baseFare, shirinFare.distanceCharge, shirinFare.poolDiscount, shirinFare.total,
        at1d,
      ],
    );

    await bulkInsert(
      client,
      "fare_legs",
      [
        "request_id", "leg_no", "leg_id", "from_stop", "to_stop",
        "riders_on_leg", "discount_pct", "price_paisa", "paid_paisa",
      ],
      [
        ...fareLineRows("req-seed-1", nusratFare),
        ...fareLineRows("req-seed-2", rafiqFare),
        ...fareLineRows("req-seed-3", shirinFare),
      ],
    );

    await bulkInsert(
      client,
      "ride_events",
      ["ride_id", "request_id", "event", "actor_id", "at", "meta"],
      [
        [null, "req-seed-1", "REQUEST_CREATED", "nusrat", at2d, null],
        [null, "req-seed-2", "REQUEST_CREATED", "rafiq", at2d, null],
        ["ride-seed-1", null, "MATCHED", "jashim", at2d, null],
        ["ride-seed-1", null, "DRIVER_ARRIVED", "jashim", at2d, null],
        ["ride-seed-1", null, "STARTED", "jashim", at2d, null],
        ["ride-seed-1", null, "COMPLETED", "jashim", at2d, null],
        [null, "req-seed-3", "REQUEST_CREATED", "shirin", at1d, null],
        [null, "req-seed-3", "CANCELLED", "shirin", at1d, JSON.stringify({ reason: "Plans changed" })],
      ],
    );

    await client.query("COMMIT");
    logger.info("seed_done", {
      stops: Object.keys(NODES).length,
      legs: EDGES.length,
      routes: ROUTES.length,
      users: users.length,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Run directly: `npm run seed`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error("seed_failed", { error: (err as Error).message });
      process.exit(1);
    });
}
