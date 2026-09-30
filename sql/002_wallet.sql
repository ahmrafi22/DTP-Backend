-- TeslaPay — the simulated wallet (PRD §5: "Cash or simulated TeslaPay
-- wallet - no real gateway needed").
--
-- Money stays integer paisa like every other amount in this schema, so a
-- balance can never pick up float drift.
--
-- wallets            one row per user, created lazily on first use. The
--                    CHECK (balance_paisa >= 0) is the database-level backstop
--                    against a negative balance — the same belt-and-braces
--                    approach rides.seats_taken <= capacity takes (PRD §11).
--
-- wallet_transactions  append-only ledger. amount_paisa is SIGNED (+ credit,
--                    - debit) and balance_after_paisa snapshots the balance
--                    after the write, so any balance can be reconciled by
--                    replaying one user's rows.

CREATE TABLE IF NOT EXISTS wallets (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_paisa BIGINT NOT NULL DEFAULT 0 CHECK (balance_paisa >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL for a plain top-up; set when the entry settles a ride.
  request_id          TEXT REFERENCES ride_requests(id) ON DELETE SET NULL,
  -- The other party on a ride settlement (the driver earning, the passenger
  -- paying). NULL on a top-up.
  counterparty_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('TOPUP', 'RIDE_CHARGE', 'RIDE_EARNING')),
  -- Signed: positive credits the wallet, negative debits it.
  amount_paisa        BIGINT NOT NULL CHECK (amount_paisa <> 0),
  balance_after_paisa BIGINT NOT NULL CHECK (balance_after_paisa >= 0),
  at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- How the rider intends to pay. CASH is the default so existing rows and every
-- request made without a choice keep working untouched.
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'CASH'
  CHECK (payment_method IN ('CASH', 'WALLET'));

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, at DESC);