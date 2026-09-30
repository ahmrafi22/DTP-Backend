import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "../shared/db.js";
import { logger } from "../shared/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
// This module lives two levels below the project root — src/db/ when run via
// tsx, dist/db/ when compiled — so the schema directory is two levels up.
// One level up would resolve to src/sql, which does not exist.
const sqlDir = join(here, "..", "..", "sql");

/** Apply every sql/*.sql file not yet recorded in schema_migrations. */
export async function migrate(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if ((applied.rowCount ?? 0) > 0) {
      logger.info("migration_skip", { file });
      continue;
    }

    const sql = await readFile(join(sqlDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      logger.info("migration_applied", { file });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

// Run directly: `npm run migrate`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error("migration_failed", { error: (err as Error).message });
      process.exit(1);
    });
}
