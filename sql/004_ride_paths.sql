-- A shuttle's path belongs to the ride (its corridor), not to whichever rider
-- happens to be aboard — so empty shuttles still have a route and stay
-- joinable. (Split from 003, which was already applied.)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS stop_ids TEXT[];
