-- Migration 006: dispatch engine v1 — departure-scoped assignments
-- Run in Supabase SQL Editor (idempotent). Requires 001-005.
--
-- PRD Phase 1 (FR-09/10/11, 6.3-6.10): the dispatch engine assigns approved
-- requests to *scheduled departures*, not just "a bus". Each (bus, departure)
-- pair is an independent trip with its own capacity, so recording which
-- departure a student was dispatched onto is required for:
--   * the per-request decision audit (7.10)
--   * correct per-trip capacity on later dispatch runs
--   * telling students WHICH run (e.g. "the 7:45") they are on
--
-- Legacy rows (created by the old time-blind auto-assign) keep
-- departure_time = NULL and stay readable as history.

ALTER TABLE bus_assignments
  ADD COLUMN IF NOT EXISTS departure_time TIMESTAMPTZ;

-- Per-trip load lookups: engine counts assignments per (bus, departure).
CREATE INDEX IF NOT EXISTS idx_assignments_bus_departure
  ON bus_assignments(bus_number, departure_time);

-- ============================================================
-- Sanity check — expect assignments_have_departure_time 1
-- ============================================================
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'bus_assignments'
       AND column_name = 'departure_time') AS assignments_have_departure_time;
