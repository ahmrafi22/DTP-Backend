import { pathToFileURL } from "node:url";
import { pool, query } from "../shared/db.js";
import { logger } from "../shared/logger.js";

/**
 * Reset every rider-facing journey while leaving the map intact.
 *
 * The demo map is database-backed: stops, legs and corridors are what the
 * autos drive along, and re-seeding them on every reset would just churn rows
 * that never change. So this wipes only the *journeys* — rides, requests,
 * fares, the event log and the wallet ledger — and keeps the geography, the
 * users and their vehicles, so a signed-in session survives and logins keep
 * working.
 *
 * Tables are resolved at runtime rather than hard-coded into one TRUNCATE, so
 * this keeps working when optional tables (the TeslaPay wallet) are or are not
 * present in the current schema.
 */

/** Journey tables, wiped. Order does not matter — CASCADE handles the rest. */
const JOURNEY_TABLES = [
  "ride_events",
  "fare_legs",
  "wallet_transactions",
  "wallets",
  "ride_requests",
  "rides",
] as const;

/** Geography and identity tables, deliberately left alone. */
const PRESERVED_TABLES = [
  "stops",
  "legs",
  "routes",
  "route_stops",
  "users",
  "vehicles",
] as const;

export interface ResetResult {
  /** Journey tables that existed and were emptied. */
  cleared: string[];
  /** Journey tables absent from this schema, so nothing to clear. */
  skipped: string[];
  /** Tables confirmed untouched. */
  preserved: string[];
}

export async function resetUserData(): Promise<ResetResult> {
  // to_regclass() returns NULL for a table that does not exist, so one query
  // tells us which journey tables this schema actually has.
  const wanted = [...JOURNEY_TABLES, ...PRESERVED_TABLES];
  const { rows } = await query<{ name: string; present: boolean }>(
    `SELECT t.name, to_regclass('public.' || t.name) IS NOT NULL AS present
     FROM unnest($1::text[]) AS t(name)`,
    [wanted],
  );

  const present = new Set(rows.filter((r) => r.present).map((r) => r.name));
  const cleared = JOURNEY_TABLES.filter((t) => present.has(t));
  const skipped = JOURNEY_TABLES.filter((t) => !present.has(t));
  const preserved = PRESERVED_TABLES.filter((t) => present.has(t));

  if (cleared.length > 0) {
    // Single statement so it is one atomic, fully-truncated operation.
    await query(`TRUNCATE ${cleared.join(", ")} RESTART IDENTITY CASCADE`);
  }

  // A stale online flag would leave the driver console looking busy.
  if (present.has("users")) {
    await query("UPDATE users SET is_online = FALSE WHERE is_online");
  }

  return { cleared, skipped, preserved };
}

// Run directly: `npm run reset`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await resetUserData();
    logger.info("reset_done", result as unknown as Record<string, unknown>);
    console.log("Journey data cleared:", result.cleared.join(", ") || "(none)");
    console.log("Kept (map + accounts):", result.preserved.join(", ") || "(none)");
    if (result.skipped.length > 0) {
      console.log("Not in this schema:", result.skipped.join(", "));
    }
  } catch (err) {
    logger.error("reset_failed", { error: (err as Error).message });
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}