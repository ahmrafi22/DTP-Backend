-- Dhaka Tesla Pool — initial schema.
-- Money is integer paisa everywhere (PRD §6): no float rounding errors.
-- rides.seats_taken <= capacity is a database-level backstop against
-- overbooking, even if application code ever has a bug (PRD §11).

-- ---------- geography first (users reference stops) ----------

CREATE TABLE IF NOT EXISTS stops (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone TEXT NOT NULL,
  lat  DOUBLE PRECISION NOT NULL,
  lng  DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS legs (
  id           TEXT PRIMARY KEY,          -- 'a~b' with sorted endpoint ids
  from_stop    TEXT NOT NULL REFERENCES stops(id),
  to_stop      TEXT NOT NULL REFERENCES stops(id),
  km           NUMERIC(5,2) NOT NULL CHECK (km > 0),
  congestion   NUMERIC(3,2) NOT NULL CHECK (congestion > 0),
  duration_min INT NOT NULL CHECK (duration_min > 0),
  price_paisa  INT NOT NULL CHECK (price_paisa > 0)
);

CREATE TABLE IF NOT EXISTS routes (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  corridor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_stops (
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  position INT NOT NULL CHECK (position >= 0),
  stop_id  TEXT NOT NULL REFERENCES stops(id),
  PRIMARY KEY (route_id, position)
);

-- ---------- people and vehicles ----------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('passenger', 'driver', 'admin')),
  home_stop_id  TEXT REFERENCES stops(id),
  is_online     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  driver_id   TEXT NOT NULL UNIQUE REFERENCES users(id),
  name        TEXT NOT NULL,
  capacity    INT  NOT NULL CHECK (capacity > 0 AND capacity <= 8),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- rides ----------

-- One pool/trip run by one vehicle. Born at MATCHED when the driver accepts.
CREATE TABLE IF NOT EXISTS rides (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id),
  status      TEXT NOT NULL CHECK (status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED', 'COMPLETED', 'CANCELLED')),
  seats_taken INT NOT NULL DEFAULT 0 CHECK (seats_taken >= 0),
  capacity    INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (seats_taken <= capacity)
);

-- One passenger's membership in (or candidacy for) a ride.
CREATE TABLE IF NOT EXISTS ride_requests (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  passenger_id          TEXT NOT NULL REFERENCES users(id),
  ride_id               TEXT REFERENCES rides(id) ON DELETE SET NULL,
  pickup_stop           TEXT NOT NULL REFERENCES stops(id),
  drop_stop             TEXT NOT NULL REFERENCES stops(id),
  route_id              TEXT REFERENCES routes(id),   -- null = multi-corridor path
  leg_ids               TEXT[] NOT NULL,
  stop_ids              TEXT[] NOT NULL,
  seats                 INT NOT NULL DEFAULT 1 CHECK (seats >= 1),
  status                TEXT NOT NULL DEFAULT 'REQUESTED'
                        CHECK (status IN ('REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED', 'COMPLETED', 'CANCELLED')),
  base_fare_paisa       INT NOT NULL DEFAULT 0 CHECK (base_fare_paisa >= 0),
  distance_charge_paisa INT NOT NULL DEFAULT 0 CHECK (distance_charge_paisa >= 0),
  pool_discount_paisa   INT NOT NULL DEFAULT 0 CHECK (pool_discount_paisa >= 0),
  total_fare_paisa      INT NOT NULL DEFAULT 0 CHECK (total_fare_paisa >= 0),
  idempotency_key       TEXT UNIQUE,
  rating                SMALLINT CHECK (rating BETWEEN 1 AND 5),
  cancel_reason         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-leg price lines so any fare can be explained after the fact (PRD §6).
CREATE TABLE IF NOT EXISTS fare_legs (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  request_id    TEXT NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
  leg_no        INT NOT NULL CHECK (leg_no >= 0),
  leg_id        TEXT NOT NULL REFERENCES legs(id),
  from_stop     TEXT NOT NULL,
  to_stop       TEXT NOT NULL,
  riders_on_leg INT NOT NULL CHECK (riders_on_leg BETWEEN 1 AND 8),
  discount_pct  INT NOT NULL CHECK (discount_pct IN (0, 20, 30)),
  price_paisa   INT NOT NULL CHECK (price_paisa > 0),
  paid_paisa    INT NOT NULL CHECK (paid_paisa >= 0),
  UNIQUE (request_id, leg_no)
);

-- Audit trail of every transition, with the actor (PRD §4).
CREATE TABLE IF NOT EXISTS ride_events (
  id         BIGSERIAL PRIMARY KEY,
  ride_id    TEXT REFERENCES rides(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES ride_requests(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  actor_id   TEXT REFERENCES users(id),
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta       JSONB
);

-- ---------- indexes (PRD §10) ----------

CREATE INDEX IF NOT EXISTS idx_ride_requests_passenger ON ride_requests(passenger_id);
CREATE INDEX IF NOT EXISTS idx_ride_requests_ride      ON ride_requests(ride_id);
CREATE INDEX IF NOT EXISTS idx_rides_status            ON rides(status);
CREATE INDEX IF NOT EXISTS idx_ride_events_ride_at     ON ride_events(ride_id, at);
-- Driver inbox: pending requests only.
CREATE INDEX IF NOT EXISTS idx_ride_requests_pending   ON ride_requests(created_at) WHERE status = 'REQUESTED';
-- Fare lookup per request.
CREATE INDEX IF NOT EXISTS idx_fare_legs_request       ON fare_legs(request_id);
