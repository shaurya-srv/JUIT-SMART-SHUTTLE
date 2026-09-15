-- Migration 009: trips entity + GPS positions (Phase 3, steps 1-2)
-- Run in Supabase SQL Editor (idempotent). Requires 001-008.
--
-- Design: TRIPS_GPS_DESIGN.md (repo root). Key points:
--   * A trip identity ALREADY exists: occupancy_events (008) and
--     bus_assignments.departure_time (006) both key trips as
--     (bus_number, departure_time). `trips` adopts that identity with a
--     UNIQUE constraint — no changes to any existing table, and a trip row
--     can be attached retroactively at any time.
--   * Thin/lazy: rows are created only when a conductor starts a trip.
--     Every Phase 1/2 flow works with zero trips rows.
--   * trip_positions is INSERT-only (free route history for Phase 4 ETAs);
--     prune rows older than 7 days opportunistically on each POST.
--   * GPS ingest/serving itself is step 3 — this migration only creates the
--     tables so the lifecycle code (step 2) can ship against them.

CREATE TABLE IF NOT EXISTS trips (
  trip_id          BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  bus_number       INTEGER NOT NULL REFERENCES buses(bus_number),
  departure_time   TIMESTAMPTZ NOT NULL,
  route_pickup     INTEGER NOT NULL,
  route_dropoff    INTEGER NOT NULL,
  state            VARCHAR(12) NOT NULL DEFAULT 'SCHEDULED'
                   CHECK (state IN ('SCHEDULED','BOARDING','DEPARTED','EN_ROUTE','COMPLETED','CANCELLED')),
  boarded_count    INTEGER NOT NULL DEFAULT 0,
  actual_departure TIMESTAMPTZ,
  actual_arrival   TIMESTAMPTZ,
  created_by       VARCHAR(60),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bus_number, departure_time)
);

CREATE INDEX IF NOT EXISTS idx_trips_state ON trips(state);

CREATE TABLE IF NOT EXISTS trip_positions (
  position_id  BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  trip_id      BIGINT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  accuracy_m   DOUBLE PRECISION,
  speed_mps    DOUBLE PRECISION,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_positions_latest
  ON trip_positions(trip_id, recorded_at DESC);

-- Route stop coordinates for the join-running-bus engine (FR-17). The join
-- check derives "has the bus passed my stop yet" from these coordinates via
-- corridor projection — stop ORDER is never assumed from location indexes,
-- so correcting a coordinate here automatically corrects the behavior.
-- NOTE: values below are APPROXIMATE along the JUIT-Waknaghat highway.
-- Ground-truth them on a map and UPDATE these rows; a NULL coordinate makes
-- the join check fail SAFE (reject with stop_coords_missing), never guess.
CREATE TABLE IF NOT EXISTS route_stops (
  location_index INTEGER PRIMARY KEY,
  name           VARCHAR(50) NOT NULL,
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION
);

INSERT INTO route_stops (location_index, name, lat, lng) VALUES
  (0, 'JUIT',        31.0176, 77.0735),
  (1, 'Ravli PG',    31.0128, 77.0795),
  (2, 'Peach Tree',  31.0092, 77.0838),
  (3, 'Waknaghat',   31.0055, 77.0885)
ON CONFLICT (location_index) DO NOTHING;


-- ============================================================================
-- SANITY CHECK additions (see apply_all_pending.sql for the combined grid):
--   trips_table=1 · trip_positions_table=1 · route_stops_seeded=4
-- ============================================================================
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_name = 'trips')             AS trips_table,
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_name = 'trip_positions')    AS trip_positions_table,
  (SELECT COUNT(*) FROM route_stops WHERE lat IS NOT NULL)
                                             AS route_stops_seeded;
