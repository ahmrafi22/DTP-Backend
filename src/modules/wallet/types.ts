import type { QueryResultRow } from "pg";

/**
 * Wallet rows as Postgres hands them back.
 *
 * `balance_paisa` and `amount_paisa` are BIGINT, which the pg driver returns as
 * a *string* to avoid precision loss — that is the driver being careful, not a
 * modelling mistake, so these are typed `string` and converted once, explicitly,
 * at the edge.
 */

export interface WalletRow extends QueryResultRow {
  user_id: string;
  balance_paisa: string;
  created_at: Date;
  updated_at: Date;
}

export interface WalletTransactionRow extends QueryResultRow {
  id: string;
  user_id: string;
  request_id: string | null;
  counterparty_id: string | null;
  kind: "TOPUP" | "RIDE_CHARGE" | "RIDE_EARNING";
  amount_paisa: string;
  balance_after_paisa: string;
  at: Date;
}