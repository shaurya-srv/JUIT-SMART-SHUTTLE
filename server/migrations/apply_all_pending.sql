-- ============================================================================
-- ONE-SHOT APPLY: migrations 002 + 003 + 004 for Supabase SQL Editor
-- (all three are idempotent — re-running is always safe)
-- Applies, in order:
--   002  Mon–Sat fixed timetable (6 buses, 12 departures)
--   003  Sunday van service (6 vans, 12 departures)
--   004  dispatch foundation columns (required_time, vehicle_type, state, ...)
--   005  admin-managed student passwords (must_change_password, audit stamp)
--   006  dispatch engine (departure-scoped assignments)
--   007  login rate limiting (login_failures table)
-- Ends with a sanity-check query — expect buses_total=12, vans=6,
-- schedules_total=24, van_departures=12, buses_vehicle_typed=12, reqs_typed=1,
-- students_have_flags=1, assignments_have_departure_time=1,
-- login_failures_table=1.
-- ============================================================================


-- ============================================================================
-- MIGRATION 002: seed the fixed weekly shuttle timetable (Mon-Sat service;
-- Sundays are vans-only, no fixed bus runs)
-- ============================================================================

-- 1) Ensure a bus exists for each of the six direct runs.
WITH missing_routes AS (
  SELECT r.pickup, r.dropoff
  FROM (VALUES (1, 0), (2, 0), (3, 0),   -- morning: Ravli PG / Peach Tree / Waknaghat -> JUIT
               (0, 1), (0, 2), (0, 3)) AS r(pickup, dropoff)  -- evening: JUIT -> each hostel
  WHERE NOT EXISTS (
    SELECT 1 FROM buses b
    WHERE b.route_pickup = r.pickup AND b.route_dropoff = r.dropoff
  )
),
numbered AS (
  SELECT pickup, dropoff,
         COALESCE((SELECT MAX(bus_number) FROM buses), 0)
           + ROW_NUMBER() OVER (ORDER BY pickup, dropoff) AS bn
  FROM missing_routes
)
INSERT INTO buses (bus_number, route_pickup, route_dropoff, current_count, max_capacity)
SELECT bn, pickup, dropoff, 0, 30
FROM numbered;

-- 2) Attach the fixed departures to the lowest-numbered bus of each route.
INSERT INTO bus_schedules (bus_number, departure_time, label)
SELECT fleet.bus_number, s.departure_time, s.label
FROM (
  SELECT DISTINCT ON (route_pickup, route_dropoff) bus_number, route_pickup, route_dropoff
  FROM buses
  ORDER BY route_pickup, route_dropoff, bus_number
) fleet
JOIN (
  VALUES
    ('07:45'::time, 1, 0, 'Morning run · Mon-Sat'),
    ('08:15'::time, 1, 0, 'Morning run · Mon-Sat'),
    ('07:45'::time, 2, 0, 'Morning run · Mon-Sat'),
    ('08:15'::time, 2, 0, 'Morning run · Mon-Sat'),
    ('07:45'::time, 3, 0, 'Morning run · Mon-Sat'),
    ('08:15'::time, 3, 0, 'Morning run · Mon-Sat'),
    ('16:55'::time, 0, 1, 'Evening return · Mon-Sat'),
    ('17:30'::time, 0, 1, 'Evening return · Mon-Sat'),
    ('16:55'::time, 0, 2, 'Evening return · Mon-Sat'),
    ('17:30'::time, 0, 2, 'Evening return · Mon-Sat'),
    ('16:55'::time, 0, 3, 'Evening return · Mon-Sat'),
    ('17:30'::time, 0, 3, 'Evening return · Mon-Sat')
) AS s(departure_time, pickup, dropoff, label)
  ON s.pickup = fleet.route_pickup AND s.dropoff = fleet.route_dropoff
WHERE NOT EXISTS (
  SELECT 1 FROM bus_schedules x
  WHERE x.bus_number = fleet.bus_number AND x.departure_time = s.departure_time
);


-- ============================================================================
-- MIGRATION 003: Sunday van service (Mon-Sat is buses; Sunday is vans only)
-- One atomic statement: new vans' RETURNING rows feed the schedule insert.
-- ============================================================================

WITH missing_routes AS (
  SELECT r.pickup, r.dropoff
  FROM (VALUES (1, 0), (2, 0), (3, 0),   -- morning: Ravli PG / Peach Tree / Waknaghat -> JUIT
               (0, 1), (0, 2), (0, 3)) AS r(pickup, dropoff)  -- evening: JUIT -> each hostel
  WHERE NOT EXISTS (
    SELECT 1 FROM buses b
    WHERE b.route_pickup = r.pickup AND b.route_dropoff = r.dropoff
      AND EXISTS (SELECT 1 FROM bus_schedules s
                  WHERE s.bus_number = b.bus_number AND s.label LIKE 'Van%')
  )
),
numbered AS (
  SELECT pickup, dropoff,
         COALESCE((SELECT MAX(bus_number) FROM buses), 0)
           + ROW_NUMBER() OVER (ORDER BY pickup, dropoff) AS bn
  FROM missing_routes
),
new_vans AS (
  INSERT INTO buses (bus_number, route_pickup, route_dropoff, current_count, max_capacity)
  SELECT bn, pickup, dropoff, 0, 12
  FROM numbered
  RETURNING bus_number, route_pickup, route_dropoff
),
existing_vans AS (
  SELECT DISTINCT ON (b.route_pickup, b.route_dropoff)
         b.bus_number, b.route_pickup, b.route_dropoff
  FROM buses b
  JOIN bus_schedules s ON s.bus_number = b.bus_number AND s.label LIKE 'Van%'
  ORDER BY b.route_pickup, b.route_dropoff, b.bus_number
),
van_fleet AS (
  SELECT bus_number, route_pickup, route_dropoff FROM new_vans
  UNION
  SELECT bus_number, route_pickup, route_dropoff FROM existing_vans
)
INSERT INTO bus_schedules (bus_number, departure_time, label)
SELECT v.bus_number, s.departure_time, s.label
FROM (
  SELECT DISTINCT ON (route_pickup, route_dropoff) bus_number, route_pickup, route_dropoff
  FROM van_fleet
  ORDER BY route_pickup, route_dropoff, bus_number
) v
JOIN (
  VALUES
    ('09:00'::time, 1, 0, 'Sunday van · 9:00/10:30 AM out'),
    ('10:30'::time, 1, 0, 'Sunday van · 9:00/10:30 AM out'),
    ('09:00'::time, 2, 0, 'Sunday van · 9:00/10:30 AM out'),
    ('10:30'::time, 2, 0, 'Sunday van · 9:00/10:30 AM out'),
    ('09:00'::time, 3, 0, 'Sunday van · 9:00/10:30 AM out'),
    ('10:30'::time, 3, 0, 'Sunday van · 9:00/10:30 AM out'),
    ('16:55'::time, 0, 1, 'Sunday van · 4:55/5:30 PM back'),
    ('17:30'::time, 0, 1, 'Sunday van · 4:55/5:30 PM back'),
    ('16:55'::time, 0, 2, 'Sunday van · 4:55/5:30 PM back'),
    ('17:30'::time, 0, 2, 'Sunday van · 4:55/5:30 PM back'),
    ('16:55'::time, 0, 3, 'Sunday van · 4:55/5:30 PM back'),
    ('17:30'::time, 0, 3, 'Sunday van · 4:55/5:30 PM back')
) AS s(departure_time, pickup, dropoff, label)
  ON s.pickup = v.route_pickup AND s.dropoff = v.route_dropoff
WHERE NOT EXISTS (
  SELECT 1 FROM bus_schedules x
  WHERE x.bus_number = v.bus_number AND x.departure_time = s.departure_time
);


-- ============================================================================
-- MIGRATION 004: Intelligent-Dispatch foundation
--   pickup_requests.required_time (FR-03, 6.5, 6.9)
--   buses.vehicle_type (6.8) + backfill for the Sunday vans
--   buses.state (7.13) + last_service / next_service (7.14)
-- ============================================================================

ALTER TABLE pickup_requests
  ADD COLUMN IF NOT EXISTS required_time TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_requests_required_time
  ON pickup_requests(required_time)
  WHERE status IN ('PENDING_APPROVAL', 'APPROVED');

ALTER TABLE buses
  ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(10)
  NOT NULL DEFAULT 'bus'
  CHECK (vehicle_type IN ('bus', 'van'));

-- Backfill: vans seeded by 003 are identified by their Van-labeled schedules.
UPDATE buses b
SET vehicle_type = 'van'
WHERE b.vehicle_type = 'bus'
  AND EXISTS (
    SELECT 1 FROM bus_schedules s
    WHERE s.bus_number = b.bus_number AND s.label LIKE 'Van%'
  );

ALTER TABLE buses
  ADD COLUMN IF NOT EXISTS state VARCHAR(15)
  NOT NULL DEFAULT 'AVAILABLE'
  CHECK (state IN ('AVAILABLE', 'DISPATCHED', 'ON_TRIP', 'MAINTENANCE', 'OFFLINE'));

ALTER TABLE buses ADD COLUMN IF NOT EXISTS last_service DATE;
ALTER TABLE buses ADD COLUMN IF NOT EXISTS next_service DATE;


-- ============================================================================
-- MIGRATION 005: admin-managed student passwords (zero self-service)
--   must_change_password — default password not yet replaced (first-login
--   change is enforced server-side); password_changed_at — audit stamp.
--   Legacy self-registered students: NULL columns keep working unchanged.
-- ============================================================================

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_students_roll ON students(roll_number);


-- ============================================================================
-- MIGRATION 006: dispatch engine v1 — departure-scoped assignments
--   bus_assignments.departure_time records WHICH scheduled run a student
--   was dispatched onto; per-trip capacity and the decision audit need it.
--   Legacy rows keep NULL (history from the old time-blind auto-assign).
-- ============================================================================

ALTER TABLE bus_assignments
  ADD COLUMN IF NOT EXISTS departure_time TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_assignments_bus_departure
  ON bus_assignments(bus_number, departure_time);


-- ============================================================================
-- MIGRATION 007: login rate limiting (brute-force protection)
--   Failed-login counters live in the DB (serverless-safe, global across
--   instances). 8 fails / 15 min per account, 30 / 15 min per IP; either
--   cap blocks logins for that identity until the window slides shut.
-- ============================================================================

CREATE TABLE IF NOT EXISTS login_failures (
  identity_key VARCHAR(64) PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_login_failures_window
  ON login_failures(window_start);


-- ============================================================================
-- SANITY CHECK — the result grid after Run should show:
--   buses_total 12 · vans 6 · schedules_total 24 · van_departures 12
--   buses_vehicle_typed 12 · requests_have_required_time 1
--   students_have_flags 1 · assignments_have_departure_time 1
--   login_failures_table 1
-- ============================================================================
SELECT
  (SELECT COUNT(*) FROM buses)                                   AS buses_total,
  (SELECT COUNT(*) FROM buses WHERE vehicle_type = 'van')        AS vans,
  (SELECT COUNT(*) FROM bus_schedules)                           AS schedules_total,
  (SELECT COUNT(*) FROM bus_schedules WHERE label LIKE 'Van%')   AS van_departures,
  (SELECT COUNT(*) FROM buses WHERE vehicle_type IS NOT NULL)    AS buses_vehicle_typed,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'pickup_requests'
       AND column_name = 'required_time')                        AS requests_have_required_time,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'students'
       AND column_name IN ('must_change_password', 'password_changed_at'))
                                                                 AS students_have_flags,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'bus_assignments'
       AND column_name = 'departure_time')                      AS assignments_have_departure_time,
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_name = 'login_failures')                       AS login_failures_table;
