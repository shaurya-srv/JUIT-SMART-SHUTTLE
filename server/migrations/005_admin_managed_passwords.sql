-- Migration 005: admin-managed student passwords (zero self-service)
-- Run in Supabase SQL Editor (idempotent). Requires 001-004.
--
-- Security model requested by the project owner:
--   * Public /api/reset-password is REMOVED (was: anyone could reset any
--     student's password knowing just the roll number).
--   * Students are mass-imported by the admin with a default password.
--   * A student must change that default password once, at first login
--     (enforced server-side), then never again through the app.
--   * Forgotten passwords go through the admin only.
--
-- No NOT NULL on the new columns: legacy self-registered students keep
-- working unchanged (NULL = no forced change).

-- ============================================================
-- 1) Flag on the student row: default password not yet replaced
-- ============================================================
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- 2) Audit timestamp of the last self-service change
--    (used by the admin panel to show "still on default password")
-- ============================================================
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- Index for the admin student list (paginated lookups by roll number).
CREATE INDEX IF NOT EXISTS idx_students_roll ON students(roll_number);

-- ============================================================
-- 3) Sanity check — expect students_have_flags 1 (columns exist)
-- ============================================================
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'students'
       AND column_name IN ('must_change_password', 'password_changed_at')
  ) AS students_have_flags;
