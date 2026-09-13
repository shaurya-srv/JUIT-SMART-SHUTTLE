-- Migration 002: seed the fixed weekly shuttle timetable (Mon-Sat service;
-- Sundays are vans-only, no fixed bus runs)
-- Run in Supabase SQL Editor (idempotent). Requires migration 001.
--
-- Mirrors the real JUIT shuttle schedule students rely on:
--   * Morning:  hostels -> JUIT campus at 07:45 and 08:15
--   * Evening:  JUIT campus -> hostels at 16:55 (4:55 PM) and 17:30 (5:30 PM)
--
-- Notes on the data model:
--   * bus_schedules stores departure times only (no day-of-week column),
--     so the weekday pattern lives in the label.
--   * A bus in this app is a single-stop run, so each hostel stop x
--     direction is its own bus (6 buses cover the daily service).
--
-- Idempotent: creates any missing bus for a needed route, then adds any
-- missing departure. Re-running never duplicates buses or departures.

-- ============================================================
-- 1) Ensure a bus exists for each of the six direct runs.
--    New buses are numbered after the current MAX, and only created
--    when no bus with that exact route+direction exists yet.
-- ============================================================
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

-- ============================================================
-- 2) Attach the fixed departures to the lowest-numbered bus of each
--    route. (If a route already has several buses, only the first is
--    scheduled; extras stay as spare capacity for auto-assign.)
-- ============================================================
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
