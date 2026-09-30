import { firstOrNull, query, withTransaction } from "../../shared/db.js";
import type { DbClient } from "../../shared/db.js";
import { notFound } from "../../shared/errors.js";
import { DEFAULT_TOPUP_PAISA, STATEMENT_LIMIT } from "./wallet.constants.js";
import type { WalletRow, WalletTransactionRow } from "./types.js";

/**
 * TeslaPay — a simulated wallet with a real ledger behind it.
 *
 * Every balance change writes both the new balance and an immutable ledger
 * row, in one transaction, so `balance_after_paisa` can always be replayed to
 * reconcile a balance. There is no gateway: this is demo money by design.
 */

export interface WalletView {
  balancePaisa: number;
  currency: "BDT";
}

export interface TransactionView {
  id: string;
  kind: "TOPUP" | "RIDE_CHARGE" | "RIDE_EARNING";
  amountPaisa: number;
  balanceAfterPaisa: number;
  counterpartyId: string | null;
  requestId: string | null;
  at: string;
}

/** The caller's wallet, created on first read so the UI always has a balance. */
export async function getWallet(userId: string): Promise<WalletView> {
  const row = await ensureWallet(userId);
  return { balancePaisa: Number(row.balance_paisa), currency: "BDT" };
}

/** Insert the wallet row if it is missing; return the current row either way. */
export async function ensureWallet(userId: string): Promise<WalletRow> {
  const row = firstOrNull(
    await query<WalletRow>(
      `INSERT INTO wallets (user_id, balance_paisa)
       VALUES ($1, 0)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [userId],
    ),
  );
  if (!row) throw new Error("wallet upsert returned no row");
  return row;
}

/**
 * Credit the caller's wallet and append the matching ledger row.
 *
 * The balance write and the ledger write happen in one transaction, so a
 * balance can never move without its receipt (or vice versa).
 */
export async function topUp(
  userId: string,
  amountPaisa: number = DEFAULT_TOPUP_PAISA,
): Promise<WalletView & { transaction: TransactionView }> {
  return withTransaction(async (client) => {
    await ensureWallet(userId);

    const updated = firstOrNull(
      await client.query<WalletRow>(
        `UPDATE wallets
         SET balance_paisa = balance_paisa + $2, updated_at = now()
         WHERE user_id = $1
         RETURNING *`,
        [userId, amountPaisa],
      ),
    );
    if (!updated) throw notFound("Wallet not found");

    const tx = await insertTransaction(client, {
      userId,
      kind: "TOPUP",
      amountPaisa,
      balanceAfterPaisa: Number(updated.balance_paisa),
    });

    return {
      balancePaisa: Number(updated.balance_paisa),
      currency: "BDT" as const,
      transaction: tx,
    };
  });
}

/** The statement, newest first. */
export async function transactionsFor(
  userId: string,
  limit: number = STATEMENT_LIMIT,
): Promise<TransactionView[]> {
  const { rows } = await query<WalletTransactionRow>(
    `SELECT id, kind, amount_paisa, balance_after_paisa, counterparty_id, request_id, at
     FROM wallet_transactions
     WHERE user_id = $1
     ORDER BY at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows.map(toTransactionView);
}

async function insertTransaction(
  client: DbClient,
  entry: {
    userId: string;
    kind: "TOPUP" | "RIDE_CHARGE" | "RIDE_EARNING";
    amountPaisa: number;
    balanceAfterPaisa: number;
    counterpartyId?: string | null;
    requestId?: string | null;
  },
): Promise<TransactionView> {
  const row = firstOrNull(
    await client.query<WalletTransactionRow>(
      `INSERT INTO wallet_transactions
         (user_id, kind, amount_paisa, balance_after_paisa, counterparty_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, kind, amount_paisa, balance_after_paisa, counterparty_id, request_id, at`,
      [
        entry.userId,
        entry.kind,
        entry.amountPaisa,
        entry.balanceAfterPaisa,
        entry.counterpartyId ?? null,
        entry.requestId ?? null,
      ],
    ),
  );
  if (!row) throw new Error("wallet transaction insert returned no row");
  return toTransactionView(row);
}

function toTransactionView(row: WalletTransactionRow): TransactionView {
  return {
    id: row.id,
    kind: row.kind,
    amountPaisa: Number(row.amount_paisa),
    balanceAfterPaisa: Number(row.balance_after_paisa),
    counterpartyId: row.counterparty_id,
    requestId: row.request_id,
    at: row.at.toISOString(),
  };
}
/**
 * Settle one finished ride: the passenger's fare moves to the driver's wallet.
 *
 * Runs inside the caller's transaction so the debit, the credit and the
 * ride-request update either all land or none do. `settled_at` is the guard
 * against paying twice — a ride can reach COMPLETED by several routes (the
 * rider advancing, a drop-off, the trip finishing) and must only ever charge
 * once.
 *
 * A passenger who cannot cover the fare is left unsettled rather than being
 * charged a negative balance: the ride still happened, so it still completes,
 * and the debt is visible as an unpaid request rather than a mangled ledger.
 */
export async function settleRidePayment(
  client: DbClient,
  request: {
    id: string;
    passenger_id: string;
    payment_method: string;
    total_fare_paisa: number;
    settled_at: Date | null;
  },
  driverId: string,
): Promise<{ settled: boolean; amountPaisa: number; reason?: string }> {
  const amount = request.total_fare_paisa;

  if (request.payment_method !== "WALLET") return { settled: false, amountPaisa: amount, reason: "CASH" };
  if (request.settled_at !== null) return { settled: false, amountPaisa: amount, reason: "already settled" };
  if (amount <= 0) return { settled: false, amountPaisa: 0, reason: "nothing to charge" };

  await ensureWallet(request.passenger_id);
  await ensureWallet(driverId);

  const payer = firstOrNull(
    await client.query<WalletRow>(
      `UPDATE wallets SET balance_paisa = balance_paisa - $2, updated_at = now()
       WHERE user_id = $1 AND balance_paisa >= $2
       RETURNING *`,
      [request.passenger_id, amount],
    ),
  );
  // No row back means the conditional UPDATE matched nothing: not enough money.
  if (!payer) return { settled: false, amountPaisa: amount, reason: "insufficient funds" };

  const payee = firstOrNull(
    await client.query<WalletRow>(
      `UPDATE wallets SET balance_paisa = balance_paisa + $2, updated_at = now()
       WHERE user_id = $1 RETURNING *`,
      [driverId, amount],
    ),
  );
  if (!payee) return { settled: false, amountPaisa: amount, reason: "driver wallet missing" };

  await insertTransaction(client, {
    userId: request.passenger_id,
    kind: "RIDE_CHARGE",
    amountPaisa: -amount,
    balanceAfterPaisa: Number(payer.balance_paisa),
    counterpartyId: driverId,
    requestId: request.id,
  });
  await insertTransaction(client, {
    userId: driverId,
    kind: "RIDE_EARNING",
    amountPaisa: amount,
    balanceAfterPaisa: Number(payee.balance_paisa),
    counterpartyId: request.passenger_id,
    requestId: request.id,
  });

  await client.query(
    `UPDATE ride_requests SET paid_paisa = $2, settled_at = now() WHERE id = $1`,
    [request.id, amount],
  );

  return { settled: true, amountPaisa: amount };
}

/** The driver who ran a ride, for settling its passengers. */
export async function driverIdForRide(client: DbClient, rideId: string): Promise<string | null> {
  const row = firstOrNull(
    await client.query<{ driver_id: string }>(
      `SELECT v.driver_id FROM rides r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = $1`,
      [rideId],
    ),
  );
  return row?.driver_id ?? null;
}
