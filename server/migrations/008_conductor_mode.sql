-- Migration 008: Phase 2 — conductor mode & occupancy truth
-- Run in Supabase SQL Editor (idempotent). Requires 001-007.
--
-- PRD §4.5, §7.3-7.5, §7.15-7.17, WR-01-07:
--   * a `conductor` staff role records on-vehicle reality: walk-ins,
--     no-shows, and boarding check-ins against a dispatched departure
--   * an `occupancy_events` audit table logs every manual seat mutation
--     (who, when, trip, type, remark) — no silent changes
--   * walk-ins consume a seat through the same FR-07 capacity guard as
--     app bookings; no-shows release it
--
-- WR-01: walk-ins are only valid on a departure that has actually been
-- dispatched (the vehicle's state is DISPATCHED/ON_TRIP) — enforced in
-- service code; the schema just provides the audit trail.

-- ============================================================
-- 1) Conductor staff role (same credentials table as guard/scheduler)
--    Seeded with the same bootstrap password the other roles use; the
--    admin should change it immediately via Staff Accounts.
-- ============================================================
INSERT INTO credentials (role, password) VALUES ('conductor', 'admin')
ON CONFLICT (role) DO NOTHING;

-- ============================================================
-- 2) Occupancy audit trail (WR-05)
--    request_number NULL = walk-in / adjustment without an app booking.
-- ============================================================
CREATE TABLE IF NOT EXISTS occupancy_events (
  event_id      BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  bus_number    INTEGER NOT NULL REFERENCES buses(bus_number),
  departure_time TIMESTAMPTZ NOT NULL,
  event_type    VARCHAR(20) NOT NULL
                CHECK (event_type IN ('WALK_IN','NO_SHOW','CHECK_IN','ADJUSTMENT')),
  seat_delta    INTEGER NOT NULL,
  request_number INTEGER REFERENCES pickup_requests(request_number),
  student_label VARCHAR(100),
  remark        VARCHAR(200),
  created_by    VARCHAR(60) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_occupancy_trip
  ON occupancy_events(bus_number, departure_time);
CREATE INDEX IF NOT EXISTS idx_occupancy_created
  ON occupancy_events(created_at);

-- ============================================================
-- Sanity check — expect occupancy_events_table 1, conductor_role 1
-- ============================================================
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_name = 'occupancy_events')               AS occupancy_events_table,
  (SELECT COUNT(*) FROM credentials WHERE role = 'conductor') AS conductor_role;
