-- Liveness for the map + habitual commutes.
--
-- vehicles.base_stop_id  where a driver waits when idle (the sprite parks here)
-- vehicles.color         sprite/line color on the map
-- users.usual_drop_stop_id  a commuter's habitual destination — the booking
--                            form prefills it ("every day the same place").

ALTER TABLE users ADD COLUMN IF NOT EXISTS usual_drop_stop_id TEXT REFERENCES stops(id);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS base_stop_id TEXT REFERENCES stops(id);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS color TEXT;
