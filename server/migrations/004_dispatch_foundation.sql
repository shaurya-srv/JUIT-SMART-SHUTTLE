-- Migration 004: Intelligent-Dispatch foundation (PRD 6.1-6.9, 7.13, 7.14)
-- Run in Supabase SQL Editor (idempotent). Requires 001-003.
--
-- Adds the structural prerequisites for dispatch optimization:
--   1. pickup_requests.required_time — when the student needs transport.
--      Keystone for the 30-min booking cutoff (FR-03), earliest-deadline
--      grouping (6.5) and max-delay windows (6.9).
--   2. buses.vehicle_type — 'bus' | 'van' for smallest-suitable-vehicle
--      sizing (6.8: 3-6 students -> van, >6 -> bus). Replaces label
--      sniffing used until now.
--   3. buses.state — operational state (7.13). Only AVAILABLE vehicles are
--      picked by auto-assign; MAINTENANCE/OFFLINE are never dispatched.
--   4. buses.last_service / next_service — basic maintenance tracking (7.14).

-- ============================================================
-- 1) Requested transport time (nullable: legacy rows have none)
-- ============================================================
ALTER TABLE pickup_requests
  ADD COLUMN IF NOT EXISTS required_time TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_requests_required_time
  ON pickup_requests(required_time)
  WHERE status IN ('PENDING_APPROVAL', 'APPROVED');

-- ============================================================
-- 2) Vehicle type (bus | van)
-- ============================================================
ALTER TABLE buses
  ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(10)
  NOT NULL DEFAULT 'bus'
  CHECK (vehicle_type IN ('bus', 'van'));

-- Backfill: vans seeded by migration 003 are identified by their
-- Van-labeled schedules. Never flips an already-set non-default value.
UPDATE buses b
SET vehicle_type = 'van'
WHERE b.vehicle_type = 'bus'
  AND EXISTS (
    SELECT 1 FROM bus_schedules s
    WHERE s.bus_number = b.bus_number AND s.label LIKE 'Van%'
  );

-- ============================================================
-- 3) Operational state (7.13)
-- ============================================================
ALTER TABLE buses
  ADD COLUMN IF NOT EXISTS state VARCHAR(15)
  NOT NULL DEFAULT 'AVAILABLE'
  CHECK (state IN ('AVAILABLE', 'DISPATCHED', 'ON_TRIP', 'MAINTENANCE', 'OFFLINE'));

-- ============================================================
-- 4) Maintenance tracking (7.14)
-- ============================================================
ALTER TABLE buses ADD COLUMN IF NOT EXISTS last_service DATE;
ALTER TABLE buses ADD COLUMN IF NOT EXISTS next_service DATE;
