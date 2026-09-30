-- Wait and Save (PRD §5 stretch): the passenger promises to wait at pickup for
-- up to WAIT_SAVE_MINUTES in exchange for an extra WAIT_SAVE_DISCOUNT_PCT off
-- the distance charge. The driver gets time to fill the remaining seats, and
-- the passenger pays less for it — which is the whole point of pooling.
--
-- Columns are added with IF NOT EXISTS so this is safe to run against a
-- database that already carries a wait-and-save variant, and correct on a
-- fresh one.

ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS wait_and_save BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS wait_deadline TIMESTAMPTZ;

-- Kept separate from pool_discount_paisa so the breakdown can show *why* each
-- discount was applied: shared legs and a wait promise are different promises.
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS wait_save_discount_paisa INT NOT NULL DEFAULT 0
  CHECK (wait_save_discount_paisa >= 0);