-- Migration 007: login rate limiting (brute-force protection)
-- Run in Supabase SQL Editor (idempotent). Requires 001-006.
--
-- Vercel serverless functions are ephemeral and per-instance, so an
-- in-memory counter cannot work. Failed-login counts live here instead,
-- making the limit global across all lambda instances.
--
-- Model (sliding window, per identity key):
--   * per-account:  student:<roll>  /  staff:<role>   — max 8 fails / 15 min
--   * per-network:  ip:<address>                      — max 30 fails / 15 min
-- A login attempt is blocked while EITHER counter is at its cap; rows
-- older than the window stop counting automatically.

CREATE TABLE IF NOT EXISTS login_failures (
  identity_key VARCHAR(64) PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ
);

-- Sliding-window reads filter on window_start; the PK already serves
-- point lookups, this helps any future admin/audit scans by recency.
CREATE INDEX IF NOT EXISTS idx_login_failures_window
  ON login_failures(window_start);

-- ============================================================
-- Sanity check — expect login_failures_table 1
-- ============================================================
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_name = 'login_failures') AS login_failures_table;
