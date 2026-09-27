import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { config } from "../config/index.js";

/**
 * Single pg Pool over the Neon pooler. Money, ids and state all live in
 * Postgres — this module is the only place that talks to it.
 */

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 20_000,
});

/**
 * The slice of a pg client the application actually uses. Both `pool` and a
 * transaction's `PoolClient` satisfy it, so services can be handed either one
 * and stay unaware of which context they are running in.
 */
export type DbClient = Pick<PoolClient, "query">;

/** Single-statement read/write helper, outside any transaction. */
export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<R>> {
  return pool.query<R>(text, values);
}

/**
 * Run `fn(client)` inside one transaction. The seat-claim logic depends on
 * this: conditional UPDATE + INSERT happen atomically, and any thrown error
 * rolls everything back.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection already gone
    }
    throw err;
  } finally {
    client.release();
  }
}

/** First row of a result, or null. Saves the `rows[0] ?? null` dance. */
export function firstOrNull<R extends QueryResultRow>(res: QueryResult<R>): R | null {
  return res.rows[0] ?? null;
}

/**
 * How many rows a statement affected. `pg` types `rowCount` as nullable, which
 * makes every `> 0` check a null-guard in disguise; this keeps the guards in
 * one place instead of at each call site.
 */
export function rowsAffected(res: { rowCount: number | null }): number {
  return res.rowCount ?? 0;
}
