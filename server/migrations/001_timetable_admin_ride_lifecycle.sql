-- Migration 001: bus timetables, admin role, ride completion support
-- Run in Supabase SQL Editor (idempotent).
-- NOTE: the 'admin' credentials row is inserted by a Node script (not here)
-- because it needs a PBKDF2 hash of a strong random password.

-- ============================================================
-- Bus schedule entries: one row per planned departure of a bus
-- ============================================================
CREATE TABLE IF NOT EXISTS bus_schedules (
  schedule_id    INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  bus_number     INTEGER NOT NULL REFERENCES buses(bus_number) ON DELETE CASCADE,
  departure_time TIME    NOT NULL,
  label          VARCHAR(60),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedules_bus ON bus_schedules(bus_number);

-- ============================================================
-- Ride lifecycle: status gains a terminal COMPLETED value.
-- ============================================================
ALTER TABLE pickup_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
