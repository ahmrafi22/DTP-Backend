-- TeslaPay may go into overdraft.
--
-- The original schema pinned both the balance and the ledger snapshot to
-- `>= 0`. That made a TeslaCash fare un-settleable for anyone without enough
-- credit at the moment the ride ended: `settleRidePayment`'s conditional
-- UPDATE matched no rows, the request stayed "TeslaPay pending" forever, and
-- the driver never saw the money. The ride genuinely happened, so the honest
-- outcome is a negative balance the passenger repays on their next top-up
-- rather than a debt quietly dropped on the floor.
--
-- The ledger is already signed (amount_paisa is +/- and balance_after_paisa
-- snapshots whatever the balance became), so a balance still reconciles by
-- replaying one user's rows. Only the two `>= 0` floors have to go.

DO $$
DECLARE
  con RECORD;
BEGIN
  -- Find the guards by what they say rather than by name: an inline column
  -- CHECK is auto-named <table>_<column>_check, but a database that predates
  -- this file may have named them anything. Matching on the definition also
  -- leaves CHECK (amount_paisa <> 0) — which is not a floor and must stay.
  FOR con IN
    SELECT t.relname AS table_name, c.conname AS constraint_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c'
      AND n.nspname = current_schema()
      AND t.relname IN ('wallets', 'wallet_transactions')
      AND pg_get_constraintdef(c.oid) ~ '>=\s*0'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',
                   con.table_name, con.constraint_name);
    RAISE NOTICE 'dropped non-negative guard %.%', con.table_name, con.constraint_name;
  END LOOP;
END
$$;