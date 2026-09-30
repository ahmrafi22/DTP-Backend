# Dhaka Tesla Pool — Backend

Express + PostgreSQL API for the ride-pooling service: passengers request
seats, drivers run pooled trips, fares split per leg, and a simulated
TeslaPay wallet settles payments. TypeScript throughout.

## Run

```bash
cp .env.example .env      # fill DATABASE_URL + JWT_SECRET
npm install
npm run db:setup          # migrate + seed the demo world
npm run dev               # tsx watch, http://localhost:4000
```

Or with Docker (Postgres + API, migrates and seeds on first boot):

```bash
docker compose up --build
```

Production: `npm run build`, `npm run db:setup:prod`, `npm start`.
Deploys as-is to Vercel (`api/index.ts` serves the Express app serverless —
no `listen()` there; run migrations separately, they don't run on boot).

## Environment

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | — (required) |
| `JWT_SECRET` | Token signing secret | `dtp-dev-secret` (dev only) |
| `CORS_ORIGIN` | Allowed frontend origin | `*` |
| `PORT` | Listen port | `4000` |

## Scripts

`npm run dev` · `npm run build` / `npm start` · `npm run typecheck` ·
`npm run db:setup` (`:prod` variants run from `dist/`) · `npm test` (vitest,
reseeds per suite, runs sequentially) · `npm run db:check`.

## API

- `GET /` / `GET /health` — service info / DB reachability
- Auth — `POST /auth/register`, `POST /auth/login`, `GET /me`
- Network — `GET /network`, `POST /fare/estimate`
- Passenger — `POST /rides/request`, `GET /me/active`, `GET /me/history`,
  `GET /rides/:id`, `POST /rides/:id/cancel`, `POST /rides/:id/rate`
- Pooling — `GET /rides/open`, `POST /rides/:id/hop-on`
- Driver — `POST /driver/online`, `GET /driver/state`, `GET /driver/requests`,
  `GET /driver/history`, `POST /rides/accept`, trip transitions
  (`arrived` / `start` / `complete`), `POST /rides/:id/drop-off`
- Wallet — `GET /wallet`, `POST /wallet/top-up`, `GET /wallet/transactions`
- Admin — `GET /admin/rides`, `POST /admin/reset`

Errors use `{ error: { code, message, details? } }`.

## Layout

```
src/app.ts          Express app (also mounted by api/index.ts on Vercel)
src/server.ts       Long-running boot: migrate, listen (docker / npm start)
src/config/         Env parsing (never exits at import)
src/db/             migrate, seed, reset
src/modules/        auth, network, rides, wallet, admin
src/graph/          Dhaka road graph + pricing
src/shared/         db pool, errors, logger, types
src/middleware/     JWT auth, rate limit
api/index.ts        Vercel serverless entry
sql/                Migrations (tracked in schema_migrations)
test/               API suites (supertest, live Postgres)
```
