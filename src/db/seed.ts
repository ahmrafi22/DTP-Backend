import bcrypt from "bcryptjs";
import { pathToFileURL } from "node:url";
import { pool } from "../shared/db.js";
import { config } from "../config/index.js";
import { logger } from "../shared/logger.js";
import { EDGES, NODES, ROUTES, legsBetween, priceLegs } from "../graph/index.js";
import type { Edge, LegFare } from "../graph/index.js";
import type { DbClient } from "../shared/db.js";

/**
 * Reset + seed the living demo world.
 *
 * - Every map auto is a real driver account with a vehicle (name, capacity,
 *   base stop, map color) — the sprites are database rows, not scenery.
 * - Passengers are habitual commuters: home stop + usual drop, so the booking
 *   form prefills "the same place they go every day".
 * - History spans several days with different drivers, so history screens and
 *   the "different driver each day" story have real content.
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
  usualDrop: string | null;
  online: boolean;
}

interface SeedVehicle {
  id: string;
  driverId: string;
  name: string;
  color: string;
  base: string;
  capacity?: number;
}

/**
 * The whole map fleet as database rows — the same cast the map sprites have
 * always shown, now real accounts. `stands` never leave their base stop.
 */
const FLEET: SeedVehicle[] = [
  { id: "pahar", driverId: "jahir", name: "Pahar", color: "#475569", base: "airport" },
  { id: "bullet", driverId: "jashim", name: "Bullet", color: "#2563eb", base: "mirpur10" },
  { id: "rocket", driverId: "kabir", name: "Rocket", color: "#9333ea", base: "uttara_hb" },
  { id: "bijoy", driverId: "selim", name: "Bijoy", color: "#d97706", base: "mirpur12" },
  { id: "rocky", driverId: "rashid", name: "Rocky", color: "#059669", base: "banani" },
  { id: "speed", driverId: "salma", name: "Speed", color: "#0891b2", base: "dhanmondi27" },
  { id: "jontro", driverId: "rakib", name: "Jontro", color: "#65a30d", base: "moghbazar" },
  { id: "tornado", driverId: "habib", name: "Tornado", color: "#ea580c", base: "shyamoli" },
  { id: "raja", driverId: "nasir", name: "Raja", color: "#e11d48", base: "malibagh" },
  { id: "duronto", driverId: "aminul", name: "Duronto", color: "#7c3aed", base: "gulistan" },
  { id: "chalo", driverId: "mizan", name: "Chalo", color: "#db2777", base: "new_market" },
  { id: "tara", driverId: "ruma", name: "Tara", color: "#0d9488", base: "sadarghat" },
  { id: "rustom", driverId: "sohel", name: "Rustom", color: "#64748b", base: "gulshan2" },
  { id: "shahin", driverId: "polash", name: "Shahin", color: "#78716c", base: "azimpur" },
  { id: "jony", driverId: "babul", name: "Jony", color: "#52525b", base: "kamalapur" },
];

const DRIVER_NAMES: Record<string, string> = {
  jahir: "Jahangir", jashim: "Jashim", kabir: "Kabir", selim: "Selim",
  rashid: "Rashid", salma: "Salma", rakib: "Rakib", habib: "Habib",
  nasir: "Nasir", aminul: "Aminul", mizan: "Mizan", ruma: "Ruma",
  sohel: "Sohel", polash: "Polash", babul: "Babul",
};

/** Who is on the road right now — the rest wait at their base with the engine off. */
const ONLINE_DRIVERS = new Set(["jashim", "kabir", "rashid", "salma", "aminul", "sohel"]);

/** Fares for one pooled ride from its members' leg sets, as the engine would. */
function poolFares(members: { legs: Edge[] }[]): LegFare[] {
  const ridersPerLeg: Record<string, number> = {};
  for (const member of members) {
    for (const leg of member.legs) {
      ridersPerLeg[leg.id] = (ridersPerLeg[leg.id] ?? 0) + 1;
    }
  }
  return members.map((m) => priceLegs(m.legs, ridersPerLeg));
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

  const corridor = legsBetween("R05", "banani", "mohakhali");
  const rafiqLegs = legsBetween("R05", "banani", "gulshan1");
  const shirinLegs = legsBetween("R05", "gulshan1", "banani");
  const shirinSoloLegs = legsBetween("R01", "uttara_hb", "mohakhali");
  if (!corridor || !rafiqLegs || !shirinLegs || !shirinSoloLegs) {
    throw new Error("Seed corridors no longer connect the demo stops");
  }

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

    // ---------- people: commuters with habits + the whole driving fleet ----------
    const users: SeedUser[] = [
      { id: "nusrat", name: "Nusrat", phone: "+880 171 0001001", role: "passenger", home: "banani", usualDrop: "mohakhali", online: false },
      { id: "rafiq", name: "Rafiq", phone: "+880 171 0001002", role: "passenger", home: "banani", usualDrop: "gulshan1", online: false },
      { id: "shirin", name: "Shirin", phone: "+880 171 0001003", role: "passenger", home: "gulshan1", usualDrop: "banani", online: false },
      ...FLEET.map((v, i) => ({
        id: v.driverId,
        name: DRIVER_NAMES[v.driverId] ?? v.driverId,
        phone: `+880 181 0002${String(i + 1).padStart(3, "0")}`,
        role: "driver",
        home: v.base,
        usualDrop: null,
        online: ONLINE_DRIVERS.has(v.driverId),
      })),
      { id: "admin", name: "Demo Admin", phone: "+880 191 0009001", role: "admin", home: null, usualDrop: null, online: false },
    ];
    await bulkInsert(
      client,
      "users",
      ["id", "name", "phone", "password_hash", "role", "home_stop_id", "usual_drop_stop_id", "is_online"],
      users.map((u) => [u.id, u.name, u.phone, hash, u.role, u.home, u.usualDrop, u.online]),
    );
    await bulkInsert(
      client,
      "vehicles",
      ["id", "driver_id", "name", "capacity", "base_stop_id", "color"],
      FLEET.map((v) => [v.id, v.driverId, v.name, v.capacity ?? 3, v.base, v.color]),
    );

    // ---------- history: the same commute, different drivers each day ----------
    const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

    interface SeedRide {
      id: string;
      vehicleId: string;
      at: string;
      members: { requestId: string; passengerId: string; legs: Edge[]; stopIds: string[]; rating: number | null }[];
    }

    const seedRides: SeedRide[] = [
      {
        // Three days ago: the daily commute pooled with Rocket.
        id: "ride-seed-1",
        vehicleId: "rocket",
        at: daysAgo(3),
        members: [
          { requestId: "req-seed-1", passengerId: "nusrat", legs: corridor, stopIds: ["banani", "gulshan2", "gulshan1", "mohakhali"], rating: 5 },
          { requestId: "req-seed-2", passengerId: "rafiq", legs: rafiqLegs, stopIds: ["banani", "gulshan2", "gulshan1"], rating: 4 },
        ],
      },
      {
        // Two days ago: the same commute, solo with Bullet this time.
        id: "ride-seed-2",
        vehicleId: "bullet",
        at: daysAgo(2),
        members: [
          { requestId: "req-seed-4", passengerId: "nusrat", legs: corridor, stopIds: ["banani", "gulshan2", "gulshan1", "mohakhali"], rating: 5 },
        ],
      },
      {
        // Yesterday: Nusrat + Shirin pool on the Gulshan ring with Rocky —
        // Shirin rides the opposite way and still saves on the shared legs.
        id: "ride-seed-3",
        vehicleId: "rocky",
        at: daysAgo(1),
        members: [
          { requestId: "req-seed-5", passengerId: "nusrat", legs: corridor, stopIds: ["banani", "gulshan2", "gulshan1", "mohakhali"], rating: 4 },
          { requestId: "req-seed-6", passengerId: "shirin", legs: shirinLegs, stopIds: ["gulshan1", "gulshan2", "banani"], rating: 5 },
        ],
      },
    ];

    const faresByRequest = new Map<string, LegFare>();
    for (const ride of seedRides) {
      const fares = poolFares(ride.members.map((m) => ({ legs: m.legs })));
      ride.members.forEach((m, i) => {
        const fare = fares[i];
        if (!fare) throw new Error(`Seed fare missing for ${m.requestId}`);
        faresByRequest.set(m.requestId, fare);
      });
      await client.query(
        `INSERT INTO rides (id, vehicle_id, status, seats_taken, capacity, created_at, updated_at)
         VALUES ($1, $2, 'COMPLETED', $3, 3, $4, $4)`,
        [ride.id, ride.vehicleId, ride.members.length, ride.at],
      );
    }

    const requestRows: unknown[][] = seedRides.flatMap((ride) =>
      ride.members.map((m) => {
        const fare = faresByRequest.get(m.requestId);
        if (!fare) throw new Error(`missing fare for ${m.requestId}`);
        return [
          m.requestId, m.passengerId, ride.id, m.stopIds[0], m.stopIds[m.stopIds.length - 1], "R05",
          m.legs.map((l) => l.id), m.stopIds, 1, "COMPLETED",
          fare.baseFare, fare.distanceCharge, fare.poolDiscount, fare.total, m.rating, ride.at, ride.at,
        ];
      }),
    );

    // Shirin's cancelled solo ride yesterday evening.
    const shirinSoloFare = priceLegs(shirinSoloLegs);
    const at1d = daysAgo(1);
    requestRows.push([
      "req-seed-3", "shirin", null, "uttara_hb", "mohakhali", "R01",
      shirinSoloLegs.map((l) => l.id), ["uttara_hb", "rajlakshmi", "airport", "kurmitola", "banani", "mohakhali"],
      1, "CANCELLED", shirinSoloFare.baseFare, shirinSoloFare.distanceCharge, shirinSoloFare.poolDiscount,
      shirinSoloFare.total, null, at1d, at1d,
    ]);

    await bulkInsert(
      client,
      "ride_requests",
      [
        "id", "passenger_id", "ride_id", "pickup_stop", "drop_stop", "route_id", "leg_ids", "stop_ids",
        "seats", "status", "base_fare_paisa", "distance_charge_paisa", "pool_discount_paisa",
        "total_fare_paisa", "rating", "created_at", "updated_at",
      ],
      requestRows,
    );

    await bulkInsert(
      client,
      "fare_legs",
      [
        "request_id", "leg_no", "leg_id", "from_stop", "to_stop",
        "riders_on_leg", "discount_pct", "price_paisa", "paid_paisa",
      ],
      [
        ...fareLineRows("req-seed-1", faresByRequest.get("req-seed-1")!),
        ...fareLineRows("req-seed-2", faresByRequest.get("req-seed-2")!),
        ...fareLineRows("req-seed-4", faresByRequest.get("req-seed-4")!),
        ...fareLineRows("req-seed-5", faresByRequest.get("req-seed-5")!),
        ...fareLineRows("req-seed-6", faresByRequest.get("req-seed-6")!),
        ...fareLineRows("req-seed-3", shirinSoloFare),
      ],
    );

    const eventRows: unknown[][] = [];
    for (const ride of seedRides) {
      for (const m of ride.members) {
        eventRows.push([null, m.requestId, "REQUEST_CREATED", m.passengerId, ride.at, null]);
      }
      for (const event of ["MATCHED", "DRIVER_ARRIVED", "STARTED", "COMPLETED"]) {
        const vehicle = FLEET.find((v) => v.id === ride.vehicleId);
        if (!vehicle) throw new Error(`Seed vehicle ${ride.vehicleId} missing`);
        eventRows.push([ride.id, null, event, vehicle.driverId, ride.at, null]);
      }
    }
    eventRows.push([null, "req-seed-3", "REQUEST_CREATED", "shirin", at1d, null]);
    eventRows.push([null, "req-seed-3", "CANCELLED", "shirin", at1d, JSON.stringify({ reason: "Plans changed" })]);

    await bulkInsert(
      client,
      "ride_events",
      ["ride_id", "request_id", "event", "actor_id", "at", "meta"],
      eventRows,
    );

    await client.query("COMMIT");
    logger.info("seed_done", {
      stops: Object.keys(NODES).length,
      legs: EDGES.length,
      routes: ROUTES.length,
      users: users.length,
      drivers: FLEET.length,
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
