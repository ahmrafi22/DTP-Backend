# Dhaka Tesla Pool — Backend

Express + PostgreSQL API for the ride-pooling MVP: passengers request seats, the
pool engine matches overlapping trips, fares split per leg with pool discounts,
and seat capacity is enforced atomically at the database.

Written in TypeScript end to end — application, tests, and build config.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript 7 (strict) | The pool engine is a pile of index lookups, money arithmetic and state transitions — exactly the code that breaks silently. `strict` + `noUncheckedIndexedAccess` turn silent corruption into a compile error. |
| HTTP | Express 5 | Small and explicit; ride logic stays easy to follow |
| DB | PostgreSQL (Neon) + raw `pg` | Real constraints, FKs, row-level locking; the seat claim is one SQL statement, not ORM magic |
| Auth | JWT + bcryptjs | Stateless, no third-party dependency |
| Validation | Zod | Same schema style for request checks and errors |
| Tests | Vitest + Supertest | Fast in-process API + concurrency tests |
| Runtime | `tsx` (dev) / `tsc` + node (prod) | `tsx` gives watch-mode reloads with no build step; the build emits ESM + `.d.ts` to `dist/` |

## Run

```bash
cp .env.example .env      # fill DATABASE_URL + JWT_SECRET
npm install
npm run db:setup          # migrate + seed (demo cast, Dhaka graph, history)
npm run dev               # tsx watch, http://localhost:4000
npm test                  # vitest (reseeds per suite, runs sequentially)
```

**Before `npm test`:** the suites share this database with a running dev
server, whose auto-shuttle scheduler would keep writing trips mid-test. Stop
`npm run dev` first, or start it with `SHUTTLE_SCHEDULER=off`.

Production path:

```bash
npm run build             # tsc -> dist/ (ESM + declarations)
npm run db:setup:prod     # migrate + seed from dist/
npm start                 # node dist/server.js
```

Other scripts: `npm run typecheck` (tsc --noEmit, covers src + test + scripts),
`npm run db:check` (connectivity smoke test), `npm run test:watch`.

Health check: `GET /health`.

## Demo cast (seeded)

| Phone | Password | Role |
|---|---|---|
| +880 171 0001001 | demo1234 | Passenger (Nusrat) |
| +880 171 0001002 | demo1234 | Passenger (Rafiq) |
| +880 171 0001003 | demo1234 | Passenger (Shirin) |
| +880 181 0002001 | demo1234 | Driver (Jashim · Bullet, 3 seats) |
| +880 181 0002002 | demo1234 | Driver (Kabir · Rocket, 3 seats) |
| +880 191 0009001 | demo1234 | Admin |

## Project structure

```
src/
  app.ts            Express app (exported for supertest)
  server.ts         Boot: migrate, listen, graceful shutdown
  config.ts         Env parsing, fail fast on missing DATABASE_URL
  db.ts             pg Pool, typed query helper, withTransaction
  types.ts          DB row types + API shapes (the contract)
  graph.ts          Predefined Dhaka graph, leg pricing, Dijkstra
  errors.ts         HttpError + the error envelope middleware
  logger.ts         Structured JSON logging with a request id
  express-augment.ts  Request augmentation (req.user, req.requestId)
  migrate.ts        Applies sql/*.sql, tracked in schema_migrations
  seed.ts           Truncate + reload the demo world
  routes/           auth, network, rides, admin, params
  services/         rides (the pool engine), users
  middleware/       auth (JWT + role gate), rateLimit
sql/001_init.sql    Schema
test/               4 suites, 28 tests
```

## API overview

**Auth** — `POST /auth/register` `{name, phone, password, role, homeStopId?, vehicleName?, vehicleCapacity?}` · `POST /auth/login` · `GET /me`

**Network / fare** — `GET /network` (stops, legs, routes for pickers + map) · `POST /fare/estimate` `{pickupStopId, dropStopId, routeId?}` → solo fares with per-leg breakdown

**Passenger** (Bearer token)
- `POST /rides/request` `{pickupStopId, dropStopId, routeId?, seats?, idempotencyKey?}` — solo estimate stored; duplicate key replays the original; one active ride per passenger
- `GET /me/active` — polling endpoint: current request + trip + driver + co-riders (first name + destination only)
- `GET /me/history` — completed/cancelled with fare lines
- `GET /rides/:id` — own request only (or the driver running it)
- `POST /rides/:id/cancel` `{reason?}` — allowed REQUESTED → DRIVER_ARRIVED
- `POST /rides/:id/rate` `{rating}` — after COMPLETED

**Driver** (Bearer token)
- `POST /driver/online` `{online}`
- `GET /driver/state` — polling endpoint: online flag, active trip with riders+fares, poolable pending groups, earnings
- `GET /driver/requests`, `GET /driver/history`
- `POST /rides/accept` `{requestIds}` — creates the pool, locks seats atomically, reprices all riders
- `POST /rides/:id/join` `{requestId}` — mid-trip joiner (seat + route overlap required)
- `POST /rides/:id/arrived` / `start` / `complete` — PRD §4 transitions
- `GET /rides/:id/events` — audit trail

**Admin** — `GET /admin/rides` (role `admin`)

Errors use `{error: {code, message, details?}}` with 400/401/403/404/409/429.

## The living map (auto-shuttles)

Every fleet auto is a real driver account with a vehicle, a home stop, a map
color and a home corridor. A small scheduler (15s tick,
`src/modules/map/shuttle.ts`) keeps **~3 randomly chosen autos running at all
times**: it starts a trip in a random direction on the driver's corridor,
boards 0–3 regular commuters on random slices of the path (occupancy follows
the Dhaka time band — rush hours fill up, late night runs emptier), brings the
driver online, and completes the trip into history when the path time is up.
The ride's path lives on the ride (`rides.stop_ids`), so even an empty shuttle
has a route and stays joinable: tap the auto, pick **Get in at / Get out at**
(stops the auto has already passed are hidden), watch your fare settle live,
claim the seat.

```
GET  /map/live           one snapshot of the whole fleet (1s cache)
GET  /rides/:id/preview   price a hop-on at the current occupancy
POST /rides/:id/join      claim a seat with get-in/get-out stops
POST /rides/:id/admit     driver admits a pre-booked rider mid-trip
```

## Key decisions

**Seat locking (PRD §11).** Joining a ride claims seats with one atomic
conditional update inside a transaction:

```sql
UPDATE rides SET seats_taken = seats_taken + $2
WHERE id = $1 AND seats_taken + $2 <= capacity;
```

1 row = seat claimed, 0 rows = clean `RIDE_FULL` 409. A `CHECK (seats_taken
<= capacity)` on the table is the backstop — overbooking is impossible even
if application code has a bug. Driver accepts lock the request rows
(`SELECT ... FOR UPDATE`) and re-check `status = 'REQUESTED'`, so two
drivers racing on one request cannot both win.

**Money** is integer paisa everywhere. `fare = base + Σleg prices − Σ
discounts`, discounts 0/20/30% for 1/2/3 riders on a leg. Every membership
change regenerates `fare_legs` for the whole ride so any historical fare can
be explained.

**Determinism** — the ride lifecycle is enforced in one place (`ALLOWED_NEXT`
in `src/services/rides.ts`) and every transition is appended to
`ride_events` with the actor.

**Rate limiting** is in-memory per instance (documented demo trade-off); at
scale it moves to Redis, and joins move to optimistic locking or a
reservation queue.

**Polling, not sockets.** The MVP uses `GET /me/active` (passenger) and
`GET /driver/state` (driver) polled every few seconds — simple and good
enough for the demo; WebSockets/SSE are the first upgrade when it matters.

## What TypeScript changed here

Beyond catching the ordinary typos, the compiler found and fixed one live
bug: `src/routes/network.ts` called `legsBetween()` in the multi-corridor
branch of `POST /fare/estimate` without importing it, so any fare estimate
without an explicit `routeId` returned **500**. The happy path in the demo
always passed a routeId, which is why it survived.

The rest is structural:

- **`types.ts` separates DB rows from API shapes.** A column rename can no
  longer silently change the public contract, and `NUMERIC`/`BIGINT` columns
  are typed as the `string` that `pg` actually hands back, so the `Number()`
  conversions are visible instead of accidental.
- **`noUncheckedIndexedAccess`** makes every `NODES[id]`, `rows[0]` and
  `legs[i]` a real possibility of `undefined`, which is how the road graph
  and the fare engine got their guard clauses written once, in one place.
- **JWT claims are validated, not cast.** `authenticate` rejects a token
  whose `sub`/`role` are not well-formed instead of trusting a cast.
- **Route params go through `param(req, "id")`.** Express 5 types them as
  `string | string[] | undefined`; the helper turns a shape mismatch into a
  400 rather than `"[object Object]"` reaching a SQL query.

## Tests (33)

- PRD §6 worked example: 410/150/230 per-leg fares with ৳100 legs
- Nusrat + Rafiq pooled on R05: shared legs 20% off, solo estimate intact
- Lifecycle: full happy path; illegal transitions → 409; driver ownership
- Cancellation: free-seat + reprice, ride auto-cancel when empty, blocked
  after STARTED, foreign cancel → 403
- Concurrency: exactly one of two concurrent joiners wins the last seat;
  exactly one driver wins a contested request; over-capacity accept → 409;
  non-overlap join → 409; capacity never exceeded in the DB
- Guards: one active ride per passenger, idempotency replay, rate limit,
  ownership checks, role gating

Tests run against a live database (Neon) and reseed between suites, so they
are order-dependent and run with `fileParallelism: false`. Over a network
connection to a pooled host they can be flaky — a `Connection terminated due
to connection timeout` is infrastructure, not a product failure; re-run before
investigating.

## Known gaps

- No Dockerfile or `docker compose` yet (the PRD asks for it).
- `scripts/check-db.ts` used to carry a live Neon password as a fallback
  string; that is removed — it now reads `DATABASE_URL` from the environment
  only. Rotate that credential.
