/**
 * Connectivity smoke check: opens one connection and reports what it reached.
 *
 *   npm run db:check
 *
 * Reads DATABASE_URL from the environment only. There is deliberately no
 * fallback connection string here — a script that carries a working
 * credential in its source is a leaked credential waiting to be scraped.
 */
import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// Log the host only, never the password.
const host = (() => {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
})();

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});

try {
  await client.connect();
  const res = await client.query<{ v: string; db: string; usr: string }>(
    "select version() as v, current_database() as db, current_user as usr",
  );
  console.log(`CONNECTED to ${host}`);
  console.log(JSON.stringify(res.rows[0], null, 2));
} catch (err) {
  console.error(`FAILED to reach ${host}:`, (err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
