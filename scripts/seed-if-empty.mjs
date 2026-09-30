/**
 * Seeds the demo world only when the database is empty, so `docker compose
 * up` gives a fresh clone a populated demo without wiping real rides on every
 * restart. Run after the migrations: `node scripts/seed-if-empty.mjs`.
 */
import { pool } from "../dist/shared/db.js";
import { seed } from "../dist/db/seed.js";

try {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
  if ((rows[0]?.n ?? 0) > 0) {
    console.log("database already has users — skipping seed");
  } else {
    console.log("empty database — loading the demo world");
    await seed();
  }
  await pool.end();
  process.exit(0);
} catch (err) {
  console.error("seed-if-empty failed:", err.message);
  try {
    await pool.end();
  } catch {
    // already closed
  }
  process.exit(1);
}
