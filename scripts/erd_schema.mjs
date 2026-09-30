/**
 * The DTP schema as the ERD draws it: tables with their columns, and the
 * relationships between them.
 *
 * Kept apart from build_erd.mjs so this data can be diffed against the live
 * database (scripts/diff_schema.mjs) without regenerating the diagram.
 *
 * Verified against the live Neon database, not sql/*.sql — the migrations have
 * drifted (vehicles.color, vehicles.corridor_route_id, ride_requests.settled_at,
 * ride_events, wallets cascade, ...).
 */
/** Excalidraw's stock palette. */
export const C = {
  ink: "#1e1e1e",
  muted: "#868e96",
  line: "#495057",
  blue: { s: "#1971c2", b: "#a5d8ff" },
  purple: { s: "#6741d9", b: "#d0bfff" },
  teal: { s: "#0c8599", b: "#66d9e8" },
  green: { s: "#2f9e44", b: "#b2f2bb" },
  orange: { s: "#e8590c", b: "#ffc078" },
  gray: { s: "#868e96", b: "#d0d0d0" },
};

const col = (n, t, k) => ({ n, t, k });

// ------------------------------------------------------------------- schema

export const TABLES = [
  { name: "stops", c: C.blue, x: 90, y: 250, cols: [
    col("id", "TEXT", "PK"),
    col("name", "TEXT"),
    col("zone", "TEXT"),
    col("lat", "DOUBLE PRECISION"),
    col("lng", "DOUBLE PRECISION"),
  ]},
  { name: "legs", c: C.blue, x: 330, y: 250, cols: [
    col("id", "TEXT", "PK"),
    col("from_stop", "TEXT", "FK->stops"),
    col("to_stop", "TEXT", "FK->stops"),
    col("km", "NUMERIC(5,2)"),
    col("congestion", "NUMERIC(3,2)"),
    col("duration_min", "INT"),
    col("price_paisa", "INT"),
  ]},
  { name: "routes", c: C.blue, x: 90, y: 570, cols: [
    col("id", "TEXT", "PK"),
    col("name", "TEXT"),
    col("corridor", "TEXT"),
  ]},
  { name: "route_stops", c: C.blue, x: 90, y: 730, cols: [
    col("route_id", "TEXT", "PK FK->routes"),
    col("position", "INT", "PK"),
    col("stop_id", "TEXT", "FK->stops"),
  ]},

  { name: "users", c: C.purple, x: 680, y: 250, cols: [
    col("id", "TEXT", "PK"),
    col("name", "TEXT"),
    col("phone", "TEXT", "UQ"),
    col("password_hash", "TEXT"),
    col("role", "TEXT"),
    col("home_stop_id", "TEXT", "FK?->stops"),
    col("usual_drop_stop_id", "TEXT", "FK?->stops"),
    col("is_online", "BOOLEAN"),
    col("created_at", "TIMESTAMPTZ"),
  ]},
  { name: "vehicles", c: C.purple, x: 680, y: 580, cols: [
    col("id", "TEXT", "PK"),
    col("driver_id", "TEXT", "FK UQ->users"),
    col("name", "TEXT"),
    col("capacity", "INT"),
    col("color", "TEXT"),
    col("base_stop_id", "TEXT", "FK?->stops"),
    col("corridor_route_id", "TEXT", "FK?->routes"),
    col("created_at", "TIMESTAMPTZ"),
  ]},

  { name: "rides", c: C.teal, x: 1180, y: 250, cols: [
    col("id", "TEXT", "PK"),
    col("vehicle_id", "TEXT", "FK->vehicles"),
    col("status", "TEXT"),
    col("seats_taken", "INT"),
    col("capacity", "INT"),
    col("stop_ids", "TEXT[]"),
    col("created_at", "TIMESTAMPTZ"),
    col("updated_at", "TIMESTAMPTZ"),
  ]},
  { name: "ride_requests", c: C.teal, x: 1320, y: 560, cols: [
    col("id", "TEXT", "PK"),
    col("passenger_id", "TEXT", "FK->users"),
    col("ride_id", "TEXT", "FK?->rides"),
    col("pickup_stop", "TEXT", "FK->stops"),
    col("drop_stop", "TEXT", "FK->stops"),
    col("route_id", "TEXT", "FK?->routes"),
    col("leg_ids", "TEXT[]"),
    col("stop_ids", "TEXT[]"),
    col("seats", "INT"),
    col("status", "TEXT"),
    col("base_fare_paisa", "INT"),
    col("distance_charge_paisa", "INT"),
    col("pool_discount_paisa", "INT"),
    col("wait_save_discount_paisa", "INT"),
    col("total_fare_paisa", "INT"),
    col("payment_method", "TEXT"),
    col("paid_paisa", "INT"),
    col("idempotency_key", "TEXT", "UQ"),
    col("rating", "SMALLINT"),
    col("cancel_reason", "TEXT"),
    col("declined_by", "TEXT[]"),
    col("wait_and_save", "BOOLEAN"),
    col("wait_deadline", "TIMESTAMPTZ"),
    col("wait_decided_at", "TIMESTAMPTZ"),
    col("settled_at", "TIMESTAMPTZ"),
    col("created_at", "TIMESTAMPTZ"),
    col("updated_at", "TIMESTAMPTZ"),
  ]},

  { name: "fare_legs", c: C.green, x: 1800, y: 250, cols: [
    col("id", "TEXT", "PK"),
    col("request_id", "TEXT", "FK->ride_requests"),
    col("leg_no", "INT"),
    col("leg_id", "TEXT", "FK->legs"),
    col("from_stop", "TEXT"),
    col("to_stop", "TEXT"),
    col("riders_on_leg", "INT"),
    col("discount_pct", "INT"),
    col("price_paisa", "INT"),
    col("paid_paisa", "INT"),
  ]},
  { name: "wallets", c: C.green, x: 2400, y: 580, cols: [
    col("user_id", "TEXT", "PK FK->users"),
    col("balance_paisa", "BIGINT"),
    col("created_at", "TIMESTAMPTZ"),
    col("updated_at", "TIMESTAMPTZ"),
  ]},
  { name: "wallet_transactions", c: C.green, x: 2400, y: 770, cols: [
    col("id", "TEXT", "PK"),
    col("user_id", "TEXT", "FK->users"),
    col("request_id", "TEXT", "FK?->ride_requests"),
    col("counterparty_id", "TEXT", "FK?->users"),
    col("kind", "TEXT"),
    col("amount_paisa", "INT"),
    col("balance_after_paisa", "INT"),
    col("at", "TIMESTAMPTZ"),
  ]},

  { name: "ride_events", c: C.orange, x: 1320, y: 1160, cols: [
    col("id", "BIGINT", "PK"),
    col("ride_id", "TEXT", "FK?->rides"),
    col("request_id", "TEXT", "FK?->ride_requests"),
    col("event", "TEXT"),
    col("actor_id", "TEXT", "FK?->users"),
    col("at", "TIMESTAMPTZ"),
    col("meta", "JSONB"),
  ]},
  { name: "schema_migrations", c: C.gray, x: 1740, y: 1160, cols: [
    col("name", "TEXT", "PK"),
    col("applied_at", "TIMESTAMPTZ"),
  ]},
];

/**
 * All 24 foreign keys, in the order they are emitted.
 *
 * `via` is the list of absolute waypoints between the two anchors; the arrow
 * leaves the source box edge, walks those points, and enters the target edge.
 * Every corridor is hand-picked so connectors never run through an unrelated
 * box and never sit collinear with another connector — scripts/check_erd.mjs
 * enforces both. Crossing each other is fine and expected in an ERD.
 *
 * Shared horizontal lanes (y) and vertical lanes (x), for reference:
 *   top      180 / 200 / 225      (band labels sit at 140)
 *   mid      465 487 509 528 545 565   (users bottom 459 -> vehicles top 580)
 *   bottom   1100 / 1120 / 1300
 *   left     x = 40 and x = 70     (margin left of every box)
 *   between  x = 605 / 650 (legs->users), 1075 / 1105 / 1150 (users->rides)
 *   right    x = 1565 / 1595       (ride_requests->fare_legs)
 */
export const RELS = [
  // --- geography ---
  { s: "legs", sc: "from_stop", ss: "L", t: "stops", tc: "id", ts: "R",
    via: [[390, 321], [390, 304]] },
  { s: "legs", sc: "to_stop", ss: "L", t: "stops", tc: "id", ts: "R", td: -8,
    via: [[345, 338], [345, 296]] },
  { s: "route_stops", sc: "route_id", ss: "T", t: "routes", tc: "id", ts: "B" },
  { s: "route_stops", sc: "stop_id", ss: "L", t: "stops", tc: "id", ts: "B",
    via: [[60, 818], [60, 420], [106, 420]] },

  // --- actors ---
  { s: "users", sc: "home_stop_id", ss: "T", t: "stops", tc: "id", ts: "T", td: 40,
    via: [[790, 205], [146, 205]], opt: true },
  { s: "users", sc: "usual_drop_stop_id", ss: "T", sd: 18, t: "stops", tc: "id", ts: "T", td: 84,
    via: [[808, 180], [190, 180]], opt: true },
  { s: "vehicles", sc: "driver_id", ss: "T", sd: 110, t: "users", tc: "id", ts: "B", td: 16,
    card: "1:1" },
  { s: "vehicles", sc: "base_stop_id", ss: "L", t: "stops", tc: "id", ts: "B", td: 40,
    via: [[500, 719], [500, 440], [146, 440]], opt: true },
  { s: "vehicles", sc: "corridor_route_id", ss: "L", t: "routes", tc: "id", ts: "R",
    via: [[430, 736], [430, 624]], opt: true },

  // --- rides ---
  { s: "rides", sc: "vehicle_id", ss: "L", t: "vehicles", tc: "id", ts: "R",
    via: [[1185, 321], [1185, 634]], card: "1:N" },
  { s: "ride_requests", sc: "passenger_id", ss: "T", sd: -100, t: "users", tc: "id", ts: "R", td: 7,
    via: [[1236, 510], [1160, 510], [1160, 311]], card: "1:N" },
  { s: "ride_requests", sc: "ride_id", ss: "T", t: "rides", tc: "id", ts: "B",
    via: [[1336, 490], [1217, 490]], card: "1:N" },

  // --- requests reaching back to stops / routes ---
  { s: "ride_requests", sc: "pickup_stop", ss: "L", t: "stops", tc: "id", ts: "B", td: 120,
    via: [[1260, 665], [1260, 530], [226, 530]] },
  { s: "ride_requests", sc: "drop_stop", ss: "L", t: "stops", tc: "id", ts: "B", td: 184,
    via: [[1220, 682], [1220, 566], [290, 566]] },
  { s: "ride_requests", sc: "route_id", ss: "T", sd: 80, t: "routes", tc: "id", ts: "T",
    via: [[1416, 478], [106, 478]], opt: true },

  // --- money ---
  { s: "fare_legs", sc: "request_id", ss: "L", t: "ride_requests", tc: "id", ts: "R", td: 7,
    via: [[1770, 321], [1770, 621]], card: "1:N" },
  { s: "fare_legs", sc: "leg_id", ss: "T", t: "legs", tc: "id", ts: "T",
    via: [[1816, 232], [420, 232]], card: "1:N" },
  { s: "wallets", sc: "user_id", ss: "T", t: "users", tc: "id", ts: "R", td: -7,
    via: [[2416, 550], [1109, 550]], card: "1:1" },
  { s: "wallet_transactions", sc: "user_id", ss: "B", t: "users", tc: "id", ts: "B",
    via: [[2416, 1110], [600, 1110], [600, 550], [790, 550]] },
  { s: "wallet_transactions", sc: "request_id", ss: "R", t: "ride_requests", tc: "id", ts: "R", td: -7,
    via: [[2890, 858], [2890, 500], [1740, 500], [1740, 607]], opt: true },
  { s: "wallet_transactions", sc: "counterparty_id", ss: "R", t: "users", tc: "id", ts: "T", td: 62,
    via: [[2890, 875], [2890, 1350], [1130, 1350], [1130, 168], [852, 168]], opt: true },

  // --- audit ---
  { s: "ride_events", sc: "ride_id", ss: "T", sd: -36, t: "rides", tc: "id", ts: "L",
    via: [[1300, 1160], [1300, 460], [1201, 460]], opt: true },
  { s: "ride_events", sc: "request_id", ss: "T", sd: 30, t: "ride_requests", tc: "id", ts: "B",
    via: [[1366, 1130], [1336, 1130]], opt: true },
  { s: "ride_events", sc: "actor_id", ss: "L", t: "users", tc: "id", ts: "L",
    via: [[40, 1282], [40, 456], [740, 456], [740, 304]], opt: true },
];;;
