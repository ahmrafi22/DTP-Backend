-- Auto-shuttles: designated drivers keep cycling a corridor all day so the
-- map is always alive. The corridor is a predefined graph route; the shuttle
-- scheduler (src/modules/map/shuttle.ts) starts, fills and completes real
-- trips on it — real rows, real fares, real history.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS corridor_route_id TEXT REFERENCES routes(id);

-- A shuttle's path belongs to the ride (its corridor), not to whichever
-- rider happens to be aboard — so empty shuttles still have a route and
-- stay joinable.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS stop_ids TEXT[];
