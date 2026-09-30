/** One tap on "add money" credits this much. The UI button is deliberately fixed. */
export const TOPUP_TAKA = 100;
export const DEFAULT_TOPUP_PAISA = TOPUP_TAKA * 100;

/** Upper bound on a single top-up, so a crafted request cannot mint the world. */
export const MAX_TOPUP_PAISA = 10_000 * 100;

/** Rows returned by GET /wallet/transactions. */
export const STATEMENT_LIMIT = 25;