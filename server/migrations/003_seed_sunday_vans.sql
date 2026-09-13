-- Migration 003: Sunday van service (Mon-Sat is buses; Sunday is vans only)
-- Run in Supabase SQL Editor (idempotent). Requires migrations 001 + 002
-- (vans are numbered after the Mon-Sat buses).
--
-- Sunday runs are vans, not the regular buses, so they are seeded as their
-- own vehicles with a small 12-seat capacity. Students see real seats per
-- van departure, and auto-assign treats them like any other vehicle.
--
-- Sunday timetable (relaxed morning, normal evening):
--   * hostels -> JUIT: 09:00 and 10:30
--   * JUIT -> hostels: 16:55 and 17:30
--
-- Vans are identified by having a 'Van'-prefixed schedule label (the schema
-- has no vehicle-type column). One edge case: if someone deletes every van
-- departure through the editor and this migration is re-run, a second van
-- per route is created — harmless (it just sits as spare capacity).
--
-- The whole seed is ONE statement: data-modifying CTEs insert missing vans
-- and their RETURNING rows feed the schedule insert in the same statement,
-- so brand-new vans get their departures immediately (a two-step version
-- would fail: new vans have no Van-labeled schedule to be found by yet).

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
