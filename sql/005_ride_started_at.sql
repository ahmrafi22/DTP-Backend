-- An immutable "this ride set off at" instant.
--
-- The 90-second trip clock used to be measured from rides.updated_at, which is
-- re-stamped on *every* transition -- including a per-rider drop-off. Two
-- browsers polling either side of a drop-off therefore measured the window
-- from different instants and drew the auto in different places, and a rider
-- being dropped off sent the car backwards.
--
-- started_at is written once, on the transition into STARTED, and never
-- touched again. Every client derives the auto's position from this one fixed
-- server timestamp, so the same ride is in the same place in every session.
--
-- Backfilled from updated_at for rides already under way, since for those the
-- last transition *was* the start.

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

UPDATE rides
   SET started_at = updated_at
 WHERE started_at IS NULL
   AND status = 'STARTED';