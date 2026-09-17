// Business rules — mirrors src/core/service.c
// Pure computation + DB orchestration. No HTTP, no console I/O.

const db = require('./db');
const { locationFromName, routeIsValid, LOC_COUNT, MAX_BUSES, LOCATIONS } = require('./models');

const CORE_MAX_REQUESTS = 512;

// PRD 6.1 / FR-03: a request must be submitted at least this many minutes
// before the required transport time, creating the planning window (6.2).
const BOOKING_CUTOFF_MINUTES = 30;

// PRD 7.13: only vehicles in these states may receive auto-assignments.
const ASSIGNABLE_VEHICLE_STATES = ['AVAILABLE'];

// Campus timezone: JUIT is in India (IST, UTC+05:30). Production runs on UTC
// (Vercel), so naive "YYYY-MM-DDTHH:mm" values (what <input type="datetime-local">
// sends) must be interpreted as IST wall-clock, not server-local.
const CAMPUS_TZ_OFFSET_MINUTES = 330;
const NAIVE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

// Parse a campus-local naive datetime string into the correct UTC instant.
// Strings that already carry an offset (or any other parseable format) fall
// through to Date parsing. Returns { ok, date } or { ok: false }.
function parseCampusLocal(input) {
  if (typeof input !== 'string') return { ok: false };
  const m = NAIVE_DATETIME_RE.exec(input.trim());
  if (!m) {
    const d = new Date(input);
    return isNaN(d.getTime()) ? { ok: false } : { ok: true, date: d };
  }
  const [y, mo, d, h, mi] = input.split(/[-T :]/).map(Number);
  const epoch = Date.UTC(y, mo - 1, d, h, mi, 0) - CAMPUS_TZ_OFFSET_MINUTES * 60 * 1000;
  return { ok: true, date: new Date(epoch) };
}

// Convert a timetable 'HH:MM' (campus wall-clock) to the next occurrence at
// or after `now + skipAfterMinutes`. A departure that has effectively left
// (or leaves within the skip window) rolls to tomorrow. Pure via `now`.
function campusTimeToDate(hhmm, now, skipAfterMinutes = 10) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  const campusNow = now.getTime() + CAMPUS_TZ_OFFSET_MINUTES * 60 * 1000;
  const cd = new Date(campusNow);              // "campus-local" fake-UTC date
  let epoch = Date.UTC(cd.getUTCFullYear(), cd.getUTCMonth(), cd.getUTCDate(), h, mi)
            - CAMPUS_TZ_OFFSET_MINUTES * 60 * 1000;
  if (epoch < now.getTime() + skipAfterMinutes * 60 * 1000) {
    epoch += 24 * 60 * 60 * 1000;              // already gone → tomorrow's run
  }
  return new Date(epoch);
}

// Location rules
function coreLocationFromName(name) { return locationFromName(name); }
function coreRouteIsValid(p, d)     { return routeIsValid(p, d); }

// PRD 6.1 / FR-03 — validate a student-supplied required transport time.
// Pure function: returns { ok: true, date } or { ok: false, error } where
// error is one of 'invalid', 'past', 'cutoff'. Accepts Date or any value
// Date can parse; `now` is injectable for tests.
function parseRequiredTime(input, now = new Date()) {
  let d;
  if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'string' && NAIVE_DATETIME_RE.test(input.trim())) {
    // Naive datetime-local value = campus (IST) wall-clock, not server-local.
    const p = parseCampusLocal(input);
    d = p.ok ? p.date : new Date(input);
  } else {
    d = new Date(input);
  }
  if (!input || isNaN(d.getTime())) return { ok: false, error: 'invalid' };
  // Allow a small clock-skew margin so a just-past "now" is not rejected
  // (it then reports 'cutoff', which is the friendlier message).
  if (d.getTime() < now.getTime() - 120 * 1000) return { ok: false, error: 'past' };
  if (d.getTime() - now.getTime() < BOOKING_CUTOFF_MINUTES * 60 * 1000) {
    return { ok: false, error: 'cutoff' };
  }
  return { ok: true, date: d };
}

// Request lifecycle transitions
async function coreApproveRequest(requestNumber) {
  const [rows] = await db.query(
    'SELECT status FROM pickup_requests WHERE request_number = $1', [requestNumber]);
  if (!rows.length || rows[0].status !== 'PENDING_APPROVAL') return false;
  // db.query returns [rows, rowCount]; for UPDATE the rowCount is what matters.
  const [, rowCount] = await db.query(
    'UPDATE pickup_requests SET status = $1 WHERE request_number = $2',
    ['APPROVED', requestNumber]);
  return rowCount > 0;
}

async function coreRejectRequest(requestNumber) {
  const [rows] = await db.query(
    'SELECT status FROM pickup_requests WHERE request_number = $1', [requestNumber]);
  if (!rows.length || rows[0].status !== 'PENDING_APPROVAL') return false;
  const [, rowCount] = await db.query(
    'UPDATE pickup_requests SET status = $1 WHERE request_number = $2',
    ['REJECTED', requestNumber]);
  return rowCount > 0;
}

// Ride completion: APPROVED -> COMPLETED. Frees the bus seat (if any) but
// keeps the assignment row so the student's history still shows the bus.
async function coreCompleteRequest(requestNumber) {
  const [rows] = await db.query(
    'SELECT status FROM pickup_requests WHERE request_number = $1', [requestNumber]);
  if (!rows.length || rows[0].status !== 'APPROVED') return false;
  const [, rowCount] = await db.query(
    "UPDATE pickup_requests SET status = 'COMPLETED', completed_at = now() " +
    'WHERE request_number = $1', [requestNumber]);
  if (!(rowCount > 0)) return false;

  const [asg] = await db.query(
    'SELECT bus_number FROM bus_assignments WHERE request_number = $1', [requestNumber]);
  if (asg.length) {
    await db.query(
      'UPDATE buses SET current_count = GREATEST(current_count - 1, 0) WHERE bus_number = $1',
      [asg[0].bus_number]);
  }
  return true;
}

// ============================================================
// Dispatch engine v1 (PRD FR-09/10/11, 6.3-6.10)
// Scheduled timetable departures ARE the trips (6.6): each (bus, departure)
// pair is an independently capped trip. One pure planner + one transactional
// applier, so the policy is unit-testable without a database.
// ============================================================

const DEFAULT_DISPATCH_OPTIONS = Object.freeze({
  maxDelayMinutes: 30,             // 6.9: never plan a student past need + this
  maxEarlinessMinutes: 60,         // 6.9: don't force students to wait hours early
  vanMinSeats: 3,                  // 6.8: 3-6 students -> van ...
  vanMaxSeats: 6,                  // ...  >6 -> bus
  skipDeparturesWithinMinutes: 10, // a run leaving within 10 min is treated as gone (rolls to tomorrow)
});

function normalizeDispatchOptions(opts = {}) {
  const o = { ...DEFAULT_DISPATCH_OPTIONS, ...(opts || {}) };
  for (const k of Object.keys(DEFAULT_DISPATCH_OPTIONS)) {
    const v = Number(o[k]);
    o[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_DISPATCH_OPTIONS[k];
  }
  return o;
}

// 6.8 sizing preference among same-time candidates: a right-sized van beats
// a (big) bus beats an undersized vehicle.
function seatRank(t, opts) {
  if (t.vehicle_type === 'van') return t.capacity < opts.vanMinSeats ? 2 : 0;
  return t.capacity > opts.vanMaxSeats ? 1 : 2;
}

// PURE: decide, for every dispatchable request, which scheduled departure it
// boards (or why not). Mutates nothing; `now` injectable for tests.
//   requests:  [{ request_number, pickup_location, dropoff_location,
//                 required_time: Date|null, already_assigned: bool }]
//   vehicles:  [{ bus_number, route_pickup, route_dropoff, current_count,
//                 max_capacity, state, vehicle_type }]
//   schedules: [{ bus_number, departure_time: 'HH:MM'(:SS)?, label }]
//   tripLoads: { '<bus>|<iso>': seatsAlreadyAssignedToThatDeparture }
function planDispatch(requests, vehicles, schedules, tripLoads, now, options = {}) {
  const opts = normalizeDispatchOptions(options);
  const result = {
    assigned_count: 0,
    unassigned_count: 0,
    skipped_already_assigned: 0,
    no_bus_available: 0,
    missing_required_time: 0,
    skipped_unavailable_vehicles: 0,
    warned_bus_numbers: [],
    warned_count: 0,
    trips_used: [],
    vehicles_dispatched: [],
    decisions: [],
  };
  const byBus = new Map(vehicles.map(v => [v.bus_number, v]));
  result.skipped_unavailable_vehicles =
    vehicles.filter(v => !ASSIGNABLE_VEHICLE_STATES.includes(v.state)).length;

  // ---- Candidate trips from the timetable (6.6 "existing trips") ----
  const trips = [];
  for (const s of schedules) {
    const v = byBus.get(s.bus_number);
    if (!v || !ASSIGNABLE_VEHICLE_STATES.includes(v.state)) continue;
    const dep = campusTimeToDate(s.departure_time, now, opts.skipDeparturesWithinMinutes);
    if (!dep) continue;
    trips.push({
      bus_number: s.bus_number,
      departure_time: dep.getTime(),
      departure_iso: dep.toISOString(),
      route_pickup: v.route_pickup,
      route_dropoff: v.route_dropoff,
      capacity: v.max_capacity,
      vehicle_type: v.vehicle_type || 'bus',
      booked: tripLoads[s.bus_number + '|' + dep.toISOString()] || 0,
    });
  }
  trips.sort((a, b) => a.departure_time - b.departure_time || a.bus_number - b.bus_number);

  // ---- Requests: earliest deadline first (6.5) ----
  const pending = [];
  for (const r of requests) {
    if (r.already_assigned) { result.skipped_already_assigned++; continue; }
    if (!r.required_time) {
      // Engine is deadline-driven; a request with no required_time has no
      // window to satisfy. The booking flow requires it for new requests.
      result.missing_required_time++;
      result.decisions.push({
        request_number: r.request_number, status: 'unassigned',
        reason: 'no required time on request (legacy row) — set one or assign manually',
      });
      continue;
    }
    pending.push(r);
  }
  pending.sort((a, b) => a.required_time - b.required_time || a.request_number - b.request_number);

  const istLabel = ts =>
    new Date(ts + CAMPUS_TZ_OFFSET_MINUTES * 60 * 1000).toISOString().slice(11, 16);

  for (const r of pending) {
    const need = r.required_time.getTime();
    let best = null;
    for (const t of trips) {
      if (t.route_pickup !== r.pickup_location || t.route_dropoff !== r.dropoff_location) continue;
      if (t.departure_time < need - opts.maxEarlinessMinutes * 60000) continue;
      if (t.departure_time > need + opts.maxDelayMinutes * 60000) break; // sorted: rest only later
      if (t.capacity - t.booked <= 0) continue;
      // Prefer earliest feasible departure (minimizes lateness, keeps later
      // runs free for later deadlines); tie-break: right-sized vehicle (6.8),
      // then tightest fill, then lowest bus number for determinism.
      if (!best
        || t.departure_time < best.departure_time
        || (t.departure_time === best.departure_time && (
              seatRank(t, opts) < seatRank(best, opts)
              || (seatRank(t, opts) === seatRank(best, opts) && (
                    (t.capacity - t.booked) < (best.capacity - best.booked)
                    || t.bus_number < best.bus_number))))) {
        best = t;
      }
    }

    if (!best) {
      result.no_bus_available++;
      result.unassigned_count++;
      result.decisions.push({
        request_number: r.request_number, status: 'unassigned',
        required_time: r.required_time.toISOString(),
        reason: 'no scheduled departure on this route within the allowed window has a seat',
      });
      continue;
    }

    best.booked++;
    result.assigned_count++;
    const tu = result.trips_used.find(t =>
      t.bus_number === best.bus_number && t.departure_time === best.departure_iso);
    if (tu) {
      tu.seats_booked = best.booked;
    } else {
      result.trips_used.push({
        bus_number: best.bus_number, departure_time: best.departure_iso,
        label: istLabel(best.departure_time), vehicle_type: best.vehicle_type,
        seats_booked: best.booked, capacity: best.capacity,
      });
    }
    if (best.capacity > 0 && best.booked * 100 / best.capacity >= 80
        && !result.warned_bus_numbers.includes(best.bus_number)) {
      result.warned_bus_numbers.push(best.bus_number);
      result.warned_count++;
    }
    result.decisions.push({
      request_number: r.request_number,
      status: 'assigned',
      bus_number: best.bus_number,
      vehicle_type: best.vehicle_type,
      departure_time: best.departure_iso,
      required_time: r.required_time.toISOString(),
      reason: `scheduled ${istLabel(best.departure_time)} run — vehicle #${best.bus_number} (${best.vehicle_type}), `
        + `${best.capacity - best.booked} seat(s) left on that departure`,
    });
  }

  result.vehicles_dispatched =
    [...new Set(result.trips_used.map(t => t.bus_number))].sort((a, b) => a - b);
  return result;
}

// Transactional applier: loads live data, plans, then writes assignments
// with the FR-07 capacity guard and marks used vehicles DISPATCHED (7.13).
async function coreDispatchApprovedRequests(options = {}, now = new Date()) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [buses] = await conn.query(
      'SELECT bus_number, route_pickup, route_dropoff, current_count, max_capacity, state, vehicle_type '
      + 'FROM buses ORDER BY bus_number');
    const [schedules] = await conn.query(
      'SELECT bus_number, departure_time::text AS departure_time, label '
      + 'FROM bus_schedules ORDER BY departure_time, bus_number');
    // Seats already committed per (bus, departure) — makes dispatch re-runnable.
    const [loads] = await conn.query(
      'SELECT bus_number, departure_time, COUNT(*)::int AS n FROM bus_assignments '
      + 'WHERE departure_time IS NOT NULL GROUP BY bus_number, departure_time');
    const tripLoads = {};
    for (const row of loads) {
      tripLoads[row.bus_number + '|' + new Date(row.departure_time).toISOString()] = row.n;
    }
    const [reqRows] = await conn.query(
      'SELECT r.request_number, r.pickup_location, r.dropoff_location, r.required_time, '
      + 'EXISTS (SELECT 1 FROM bus_assignments a WHERE a.request_number = r.request_number) AS already '
      + 'FROM pickup_requests r WHERE r.status = $1', ['APPROVED']);

    const requests = reqRows.map(x => ({
      request_number: x.request_number,
      pickup_location: x.pickup_location,
      dropoff_location: x.dropoff_location,
      required_time: x.required_time ? new Date(x.required_time) : null,
      already_assigned: x.already === true,
    }));

    const plan = planDispatch(requests, buses, schedules, tripLoads, now, options);

    for (const d of plan.decisions) {
      if (d.status !== 'assigned') continue;
      // FR-07 guard, re-checked live inside the transaction.
      const [, inc] = await conn.query(
        'UPDATE buses SET current_count = current_count + 1 '
        + 'WHERE bus_number = $1 AND current_count < max_capacity', [d.bus_number]);
      if (inc !== 1) {
        d.status = 'unassigned';
        d.reason = 'vehicle filled concurrently — run dispatch again';
        plan.assigned_count--;
        plan.no_bus_available++;
        continue;
      }
      await conn.query(
        'INSERT INTO bus_assignments (request_number, bus_number, departure_time) VALUES ($1, $2, $3)',
        [d.request_number, d.bus_number, d.departure_time]);
    }

    // 7.13: vehicles with planned departures leave AVAILABLE state.
    for (const bn of plan.vehicles_dispatched) {
      await conn.query(
        "UPDATE buses SET state = 'DISPATCHED' WHERE bus_number = $1 AND state = 'AVAILABLE'", [bn]);
    }

    await conn.commit();
    return plan;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Back-compat: the old time-blind first-fit assigner, now powered by the
// dispatch engine (it fills the earliest scheduled departures per route).
// New code should call coreDispatchApprovedRequests for the decision log.
async function coreAssignApprovedRequests() {
  const r = await coreDispatchApprovedRequests();
  return {
    assigned_count: r.assigned_count,
    skipped_already_assigned: r.skipped_already_assigned,
    no_bus_available: r.no_bus_available + r.missing_required_time,
    skipped_unavailable_vehicles: r.skipped_unavailable_vehicles,
    warned_bus_numbers: r.warned_bus_numbers,
    warned_count: r.warned_count,
  };
}

// ============================================================
// Conductor mode (PRD §4.5, §7.3–7.5, §7.15–7.17, WR-01–07)
// On-vehicle reality: walk-ins, no-shows, check-ins against a DISPATCHED
// departure. Every mutation flows through the FR-07 capacity guard and
// lands in occupancy_events (WR-05) — no silent seat changes.
// ============================================================

const WALKABLE_VEHICLE_STATES = ['DISPATCHED', 'ON_TRIP'];

// PURE (WR-01/02/07): validate a walk-in/check-in/no-show before touching DB.
//   vehicle:  { state, route_pickup, route_dropoff, current_count, max_capacity } | undefined
//   tripLoad: seats already assigned to this exact departure
//   input:    { bus_number, departure_time: Date, event_type, student_roll_number? }
function validateOccupancyEvent(vehicle, tripLoad, input) {
  if (!vehicle) return { ok: false, error: 'vehicle not found' };
  if (!input.departure_time || !(input.departure_time instanceof Date)
      || isNaN(input.departure_time.getTime())) {
    return { ok: false, error: 'valid departure_time is required' };
  }
  // WR-01: only on an active/eligible trip.
  if (!WALKABLE_VEHICLE_STATES.includes(vehicle.state)) {
    return { ok: false, error: `vehicle is ${vehicle.state} — walk-ins need a dispatched trip` };
  }
  if (!['WALK_IN', 'NO_SHOW', 'CHECK_IN', 'ADJUSTMENT'].includes(input.event_type)) {
    return { ok: false, error: 'event_type must be WALK_IN, NO_SHOW, CHECK_IN or ADJUSTMENT' };
  }
  const delta = input.event_type === 'WALK_IN' ? 1
    : input.event_type === 'NO_SHOW' ? -1
    : (input.seat_delta | 0 || 0);
  if (input.event_type === 'ADJUSTMENT' && !delta) {
    return { ok: false, error: 'ADJUSTMENT needs a non-zero seat_delta' };
  }
  // WR-02: never beyond capacity, never below zero.
  const projected = vehicle.current_count + delta;
  if (projected > vehicle.max_capacity) {
    return { ok: false, error: 'vehicle is full — walk-in rejected' };
  }
  if (projected < 0) {
    return { ok: false, error: 'seat count cannot go negative' };
  }
  // WR-06 bookkeeping input sanity: label or roll for walk-ins/no-shows.
  if ((input.event_type === 'WALK_IN' || input.event_type === 'NO_SHOW')
      && !input.student_label && !input.student_roll_number) {
    return { ok: false, error: 'student name or roll number is required' };
  }
  // WR-02 continuation: a full departure (tripLoad) blocks walk-ins even when
  // the vehicle-level count has headroom (per-departure capacity).
  if (input.event_type === 'WALK_IN' && tripLoad !== undefined
      && tripLoad >= vehicle.max_capacity) {
    return { ok: false, error: 'that departure is already full' };
  }
  return { ok: true, seat_delta: delta, projected };
}

// Transactional: validate + guarded UPDATE (FR-07) + audit row (WR-05).
async function coreRecordOccupancyEvent(input, actorRole) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [buses] = await conn.query(
      'SELECT bus_number, route_pickup, route_dropoff, current_count, max_capacity, state '
      + 'FROM buses WHERE bus_number = $1', [input.bus_number]);
    const vehicle = buses[0];
    const [loads] = await conn.query(
      'SELECT COUNT(*)::int AS n FROM bus_assignments '
      + 'WHERE bus_number = $1 AND departure_time = $2',
      [input.bus_number, input.departure_time]);
    const tripLoad = loads.length ? loads[0].n : undefined;

    const v = validateOccupancyEvent(vehicle, tripLoad, input);
    if (!v.ok) {
      await conn.rollback();
      return { ok: false, error: v.error };
    }

    // FR-07 guarded seat mutation (direction-aware).
    if (v.seat_delta > 0) {
      const [, inc] = await conn.query(
        'UPDATE buses SET current_count = current_count + 1 '
        + 'WHERE bus_number = $1 AND current_count < max_capacity', [input.bus_number]);
      if (inc !== 1) {
        await conn.rollback();
        return { ok: false, error: 'vehicle filled concurrently — rejected' };
      }
    } else if (v.seat_delta < 0) {
      await conn.query(
        'UPDATE buses SET current_count = GREATEST(current_count - 1, 0) WHERE bus_number = $1',
        [input.bus_number]);
    }

    await conn.query(
      'INSERT INTO occupancy_events (bus_number, departure_time, event_type, seat_delta, '
      + 'request_number, student_label, remark, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [input.bus_number, input.departure_time, input.event_type, v.seat_delta,
       input.request_number || null, input.student_label || null,
       input.remark || null, actorRole + ':' + (input.created_by || 'unknown')]);

    // No-show (7.3): if tied to a real booking, release its assignment + seat.
    if (input.event_type === 'NO_SHOW' && input.request_number) {
      await conn.query(
        "UPDATE pickup_requests SET status = 'REJECTED' "
        + "WHERE request_number = $1 AND status = 'APPROVED'", [input.request_number]);
      await conn.query(
        'DELETE FROM bus_assignments WHERE request_number = $1', [input.request_number]);
    }

    await conn.commit();
    return { ok: true, bus_number: input.bus_number, seat_delta: v.seat_delta,
             occupancy: v.projected };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Trip log for the conductor's view: who is on this departure (app bookings)
// plus recent occupancy events (walk-ins etc.).
async function coreTripLog(busNumber, departureIso) {
  const [manifest] = await db.query(
    'SELECT r.request_number, r.pickup_place, r.dropoff_place, r.status, '
    + 's.name AS student_name, s.roll_number, s.phone_number '
    + 'FROM bus_assignments a JOIN pickup_requests r ON a.request_number = r.request_number '
    + 'JOIN students s ON r.student_roll_number = s.roll_number '
    + 'WHERE a.bus_number = $1 AND a.departure_time = $2 '
    + 'ORDER BY r.request_number', [busNumber, departureIso]);
  const [events] = await db.query(
    'SELECT event_type, seat_delta, student_label, remark, created_by, created_at '
    + 'FROM occupancy_events WHERE bus_number = $1 AND departure_time = $2 '
    + 'ORDER BY created_at DESC LIMIT 50', [busNumber, departureIso]);
  return { manifest_count: manifest.length, manifest, events };
}

// ============================================================
// Trip lifecycle (Phase 3 steps 1-2 — see TRIPS_GPS_DESIGN.md)
// A trip row adopts the identity every other table already uses:
// (bus_number, departure_time), enforced UNIQUE. Rows are created lazily by
// coreStartTrip, so all Phase 1/2 flows work with zero trips rows.
// ============================================================

const TRIP_STATES = Object.freeze(['SCHEDULED', 'BOARDING', 'DEPARTED', 'EN_ROUTE', 'COMPLETED', 'CANCELLED']);

// Allowed forward moves. One-way except CANCELLED (reachable from anything
// not yet COMPLETED) — validated by the pure canTransition below.
const TRIP_TRANSITIONS = Object.freeze({
  SCHEDULED: ['BOARDING', 'CANCELLED'],
  BOARDING:  ['DEPARTED', 'CANCELLED'],
  DEPARTED:  ['EN_ROUTE', 'CANCELLED'],
  EN_ROUTE:  ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
});

// PURE: is moving `from -> to` legal? `now` is injectable for tests (it
// currently constrains only CANCELLED; kept in the signature so time-based
// rules can be added without breaking callers).
function canTransition(from, to, now = new Date()) {
  if (!TRIP_STATES.includes(from)) return { ok: false, error: `unknown trip state ${from}` };
  if (!TRIP_STATES.includes(to))   return { ok: false, error: `unknown trip state ${to}` };
  if (from === to)                 return { ok: false, error: `trip is already ${to}` };
  if (!TRIP_TRANSITIONS[from].includes(to)) {
    return { ok: false, error: `cannot move a ${from} trip to ${to}` };
  }
  return { ok: true };
}

// Conductor starts (or re-attaches to) today's scheduled run of a bus.
// Transactional + idempotent: re-starting an active trip returns the same
// row (ON CONFLICT), never a duplicate. `input: { bus_number, departure_time: 'HH:MM' }`.
async function coreStartTrip(input, actor, now = new Date()) {
  const bn = parseInt(input.bus_number, 10);
  const hhmm = /^(\d{1,2}):(\d{2})/.exec(String(input.departure_time || '').trim());
  if (!bn || !hhmm) return { ok: false, error: 'bus_number and departure_time (HH:MM) are required' };
  const padded = String(+hhmm[1]).padStart(2, '0') + ':' + hhmm[2];

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [buses] = await conn.query(
      'SELECT bus_number, route_pickup, route_dropoff, state FROM buses WHERE bus_number = $1', [bn]);
    if (!buses.length) {
      await conn.rollback();
      return { ok: false, error: 'vehicle not found' };
    }
    const vehicle = buses[0];

    const [sched] = await conn.query(
      'SELECT 1 FROM bus_schedules WHERE bus_number = $1 AND departure_time::text LIKE $2',
      [bn, padded + '%']);
    if (!sched.length) {
      await conn.rollback();
      return { ok: false, error: `bus #${bn} has no scheduled departure at ${padded}` };
    }

    // Campus (IST) wall-clock -> real instant. Tolerance -5 min: a conductor
    // starting a run that just left still gets TODAY's identity (not tomorrow's).
    let dep = campusTimeToDate(padded, now, -5);
    if (!dep) {
      await conn.rollback();
      return { ok: false, error: `invalid departure_time ${padded}` };
    }
    // Clock-edge recovery: if the computed instant already passed, adopt the
    // departure of a recent trip row for this bus (started minutes ago from
    // the other side of the roll-forward boundary) instead of forking a
    // second trip for the same run.
    if (dep.getTime() < now.getTime()) {
      const [recent] = await conn.query(
        'SELECT departure_time FROM trips WHERE bus_number = $1 '
        + 'AND departure_time > $2 AND departure_time <= $3 '
        + 'ORDER BY departure_time DESC LIMIT 1',
        [bn, new Date(now.getTime() - 12 * 60 * 60 * 1000), now]);
      if (recent.length) dep = new Date(recent[0].departure_time);
    }

    const [upserted] = await conn.query(
      'INSERT INTO trips (bus_number, departure_time, route_pickup, route_dropoff, state, created_by) '
      + 'VALUES ($1, $2, $3, $4, \'SCHEDULED\', $5) '
      + 'ON CONFLICT (bus_number, departure_time) DO UPDATE SET updated_at = $6 '
      + 'RETURNING trip_id, state, boarded_count, actual_departure, actual_arrival',
      [bn, dep, vehicle.route_pickup, vehicle.route_dropoff,
       String(actor || 'unknown').slice(0, 60), now]);
    const trip = upserted[0];

    if (trip.state === 'COMPLETED' || trip.state === 'CANCELLED') {
      await conn.rollback();
      return { ok: false, error: `this trip is already ${trip.state} — ask the scheduler to re-dispatch` };
    }

    await conn.commit();
    return {
      ok: true,
      trip_id: trip.trip_id,
      bus_number: bn,
      departure_time: dep.toISOString(),
      route: `${LOCATIONS[vehicle.route_pickup]} → ${LOCATIONS[vehicle.route_dropoff]}`,
      state: trip.state,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Move a trip through its lifecycle. Side effects per design:
//   DEPARTED  -> buses.state = 'ON_TRIP' (closes the auto half of PRD 7.13)
//   COMPLETED -> buses.state = 'AVAILABLE', occupancy reset (vehicle emptied
//                at destination), remaining APPROVED bookings on this
//                departure completed (same completion path the guard uses)
//   CANCELLED -> same vehicle rollback when it was already rolling
async function coreSetTripState(tripId, nextState, actor, now = new Date()) {
  const gate = TRIP_STATES.includes(nextState)
    ? { ok: true }
    : { ok: false, error: `unknown trip state ${nextState}` };
  if (!gate.ok) return gate;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM trips WHERE trip_id = $1 FOR UPDATE', [tripId]);
    if (!rows.length) {
      await conn.rollback();
      return { ok: false, error: 'trip not found' };
    }
    const trip = rows[0];
    const check = canTransition(trip.state, nextState, now);
    if (!check.ok) {
      await conn.rollback();
      return check;
    }

    const departing = nextState === 'DEPARTED';
    const finishing = nextState === 'COMPLETED';
    const cancelling = nextState === 'CANCELLED';

    await conn.query(
      'UPDATE trips SET state = $1, actual_departure = COALESCE($2, actual_departure), '
      + 'actual_arrival = COALESCE($3, actual_arrival), updated_at = $4 WHERE trip_id = $5',
      [nextState, departing ? now : null, finishing ? now : null, now, tripId]);

    if (departing) {
      await conn.query(
        "UPDATE buses SET state = 'ON_TRIP' WHERE bus_number = $1 AND state IN ('DISPATCHED','ON_TRIP')",
        [trip.bus_number]);
    }
    if (finishing || cancelling) {
      await conn.query(
        "UPDATE buses SET state = 'AVAILABLE', current_count = 0 "
        + "WHERE bus_number = $1 AND state IN ('DISPATCHED','ON_TRIP')",
        [trip.bus_number]);
      if (finishing) {
        await conn.query(
          "UPDATE pickup_requests SET status = 'COMPLETED', completed_at = $1 "
          + "WHERE status = 'APPROVED' AND request_number IN "
          + '(SELECT request_number FROM bus_assignments WHERE bus_number = $2 AND departure_time = $3)',
          [now, trip.bus_number, trip.departure_time]);
      }
    }

    await conn.commit();
    return {
      ok: true,
      trip_id: tripId,
      bus_number: trip.bus_number,
      departure_time: new Date(trip.departure_time).toISOString(),
      state: nextState,
      actual_departure: departing ? now.toISOString()
        : (trip.actual_departure ? new Date(trip.actual_departure).toISOString() : null),
      actual_arrival: finishing ? now.toISOString()
        : (trip.actual_arrival ? new Date(trip.actual_arrival).toISOString() : null),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Current lifecycle state of a (bus, departure) trip, if a row exists.
// Returns { ok, exists: false } when nobody started tracking this run.
async function coreGetTrip(busNumber, departureIso) {
  const [rows] = await db.query(
    'SELECT trip_id, state, boarded_count, actual_departure, actual_arrival, updated_at '
    + 'FROM trips WHERE bus_number = $1 AND departure_time = $2',
    [busNumber, departureIso]);
  if (!rows.length) return { ok: true, exists: false };
  const t = rows[0];
  return {
    ok: true,
    exists: true,
    trip_id: t.trip_id,
    state: t.state,
    boarded_count: t.boarded_count,
    actual_departure: t.actual_departure ? new Date(t.actual_departure).toISOString() : null,
    actual_arrival: t.actual_arrival ? new Date(t.actual_arrival).toISOString() : null,
    updated_at: new Date(t.updated_at).toISOString(),
  };
}

// ============================================================
// Phase 3 steps 3-4: GPS ingest, public live board, join-running-bus
// (FR-16/17, §7.18–7.26). Geometry in lib/geo.js (pure); the join rule is
// validated here purely, then applied transactionally with FR-07 guards.
// ============================================================

const { stopPassed, isFixStale, withinDedupeWindow, plausibleFix, projectOntoSegment } = require('./geo');
const JOIN_MAX_DELAY_MINUTES = 30;   // required_time may be up to this much in the past
const JOIN_OFF_ROUTE_METERS = 2000;  // bus-position corridor tolerance
// Real stops can sit ~600 m off the straight chord between endpoints (the
// valley road bends), so this is a generous walking-distance bound.
const JOIN_WALK_METERS = 800;        // request stops must be within walking distance of the corridor

// PURE (FR-17): every hard constraint for joining a running trip, checked in
// order, each failure a SPECIFIC code — never a silent rejection (WR-07).
//   input: { request, trip, vehicle, depLoad, gps: { latest, stale } | undefined,
//            stops: { [location_index]: {lat,lng} } | undefined, now }
// Route rule (6.7): the request's endpoints must lie ON the trip's corridor
// in the right direction — so a Ravli PG student may board the Peach Tree →
// JUIT bus. Coordinate-driven when route_stops is mapped; otherwise falls
// back to strict index equality (fail safe, never guesses).
function validateJoin(input) {
  const { request, trip, vehicle, depLoad, gps, stops } = input;
  const now = input.now || new Date();

  if (!request) return { ok: false, code: 'request_not_found' };
  if (request.status !== 'APPROVED') {
    return { ok: false, code: 'not_approved', message: 'Only approved requests can join a trip.' };
  }

  // --- route + direction gate ---
  const a = stops && stops[trip.route_pickup];
  const b = stops && stops[trip.route_dropoff];
  const pS = stops && stops[request.pickup_location];
  const dS = stops && stops[request.dropoff_location];
  let pickupT;                                          // where the student boards
  if (a && b && pS && dS) {
    const pp = projectOntoSegment(pS, a, b);
    const pd = projectOntoSegment(dS, a, b);
    // Both endpoints must genuinely lie BETWEEN the trip's stops (a small
    // slack covers GPS noise): a Waknaghat stop is NOT boardable from a
    // Peach Tree -> JUIT bus, however close the chord passes.
    if (pp.tRaw < -0.05 || pp.tRaw > 1.05
        || pd.tRaw < -0.05 || pd.tRaw > 1.05
        || pp.distanceM > JOIN_WALK_METERS || pd.distanceM > JOIN_WALK_METERS
        || pd.t <= pp.t) {
      return { ok: false, code: 'route_mismatch',
        message: 'This bus does not run your way (wrong route or direction).' };
    }
    pickupT = pp.t;
  } else if (request.pickup_location !== trip.route_pickup
      || request.dropoff_location !== trip.route_dropoff) {
    return { ok: false, code: 'route_mismatch',
      message: 'This bus does not run between your pickup and drop-off.' };
  }

  // --- service window (6.9 spirit) ---
  if (request.required_time) {
    const need = request.required_time instanceof Date
      ? request.required_time.getTime() : new Date(request.required_time).getTime();
    if (!isNaN(need) && need + JOIN_MAX_DELAY_MINUTES * 60 * 1000 < now.getTime()) {
      return { ok: false, code: 'window_passed',
        message: 'Your required time has passed — create a new request instead.' };
    }
  }

  // --- capacity gate ---
  if (!vehicle) return { ok: false, code: 'vehicle_not_found' };
  if (depLoad >= vehicle.max_capacity) {
    return { ok: false, code: 'departure_full', message: 'That departure is already full.' };
  }

  // --- "has the bus passed my stop yet" (§7.18/§7.26) ---
  // Free while boarding; once rolling it needs a FRESH fix and the stop must
  // still be ahead along the corridor. Fails SAFE whenever geometry is
  // unavailable (no fix, stale fix, unmapped stops) — never guesses.
  if (trip.state === 'DEPARTED' || trip.state === 'EN_ROUTE') {
    if (!gps || !gps.latest || gps.stale) {
      return { ok: false, code: 'no_live_tracking',
        message: 'No live location right now — join before departure or try again when the conductor shares location.' };
    }
    if (!a || !b || !pS) {
      return { ok: false, code: 'stop_coords_missing',
        message: 'Your pickup stop is not mapped yet — ask the admin to set route stop coordinates.' };
    }
    const busProj = projectOntoSegment(gps.latest, a, b);
    if (busProj.distanceM > JOIN_OFF_ROUTE_METERS) {
      return { ok: false, code: 'bus_off_route',
        message: 'The bus is off its corridor right now — join unavailable.' };
    }
    if (pickupT === undefined) pickupT = projectOntoSegment(pS, a, b).t;
    if (busProj.t > pickupT + 0.02) {
      return { ok: false, code: 'stop_already_passed',
        message: 'The bus has already passed your pickup point.' };
    }
  }
  return { ok: true };
}

// Ingest one GPS fix for a trip (conductor/guard/admin via the route).
// 5 s server-side dedupe backstop; history pruned past 7 days.
async function coreIngestPosition(tripId, fix, now = new Date()) {
  if (!plausibleFix(fix)) return { ok: false, error: 'implausible coordinates' };
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [trips] = await conn.query(
      'SELECT trip_id, state FROM trips WHERE trip_id = $1', [tripId]);
    if (!trips.length) {
      await conn.rollback();
      return { ok: false, error: 'trip not found' };
    }
    if (!['BOARDING', 'DEPARTED', 'EN_ROUTE'].includes(trips[0].state)) {
      await conn.rollback();
      return { ok: false, error: `trip is ${trips[0].state} — not sharing location` };
    }
    const [last] = await conn.query(
      'SELECT recorded_at FROM trip_positions WHERE trip_id = $1 '
      + 'ORDER BY recorded_at DESC LIMIT 1', [tripId]);
    if (withinDedupeWindow(last[0], now)) {
      await conn.rollback();
      return { ok: false, dedupe: true, error: 'duplicate fix — slow down' };
    }
    const [ins] = await conn.query(
      'INSERT INTO trip_positions (trip_id, lat, lng, accuracy_m, speed_mps) '
      + 'VALUES ($1, $2, $3, $4, $5) RETURNING position_id',
      [tripId, fix.lat, fix.lng, fix.accuracy_m ?? null, fix.speed_mps ?? null]);
    // Bounded opportunistic prune (Phase 4 history window = 7 days).
    await conn.query('DELETE FROM trip_positions WHERE recorded_at < $1',
      [new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)]);
    await conn.commit();
    return { ok: true, position_id: ins[0].position_id };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Public live board: active trips + latest fix + staleness. Same privacy
// posture as /api/timetable/public — active trips only, no history, no
// student data.
async function coreActiveTrips(now = new Date()) {
  const [rows] = await db.query(
    'SELECT t.trip_id, t.bus_number, t.departure_time, t.state, '
    + 'b.vehicle_type, b.max_capacity, b.route_pickup, b.route_dropoff, '
    + '(SELECT COUNT(*)::int FROM bus_assignments a '
    + '   WHERE a.bus_number = t.bus_number AND a.departure_time = t.departure_time) AS dep_load, '
    + 'f.lat AS fix_lat, f.lng AS fix_lng, f.accuracy_m AS fix_accuracy, f.recorded_at AS fix_at '
    + 'FROM trips t JOIN buses b ON b.bus_number = t.bus_number '
    + 'LEFT JOIN LATERAL (SELECT lat, lng, accuracy_m, recorded_at '
    + '                   FROM trip_positions p WHERE p.trip_id = t.trip_id '
    + '                   ORDER BY recorded_at DESC LIMIT 1) f ON true '
    + "WHERE t.state IN ('BOARDING','DEPARTED','EN_ROUTE') ORDER BY t.departure_time");
  const trips = rows.map(r => {
    const fix = r.fix_at ? { lat: r.fix_lat, lng: r.fix_lng, recorded_at: new Date(r.fix_at) } : null;
    return {
      trip_id: r.trip_id,
      bus_number: r.bus_number,
      vehicle_type: r.vehicle_type || 'bus',
      route: `${LOCATIONS[r.route_pickup]} → ${LOCATIONS[r.route_dropoff]}`,
      state: r.state,
      departure_time: new Date(r.departure_time).toISOString(),
      seats_available: Math.max(0, r.max_capacity - r.dep_load),
      fix: fix ? { lat: r.fix_lat, lng: r.fix_lng, accuracy_m: r.fix_accuracy } : null,
      fix_age_seconds: fix ? Math.max(0, Math.round((now.getTime() - fix.recorded_at.getTime()) / 1000)) : null,
      fix_stale: isFixStale(fix, now),
    };
  });
  return { count: trips.length, trips };
}

// FR-16/17: attach an APPROVED request to a running (or boarding) trip.
// Transactional; every rejection is a specific reason; capacity moves only
// through the FR-07 guarded UPDATE.
async function coreJoinTrip(tripId, requestNumber, rollNumber, now = new Date()) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [trips] = await conn.query(
      'SELECT trip_id, bus_number, departure_time, route_pickup, route_dropoff, state '
      + 'FROM trips WHERE trip_id = $1 FOR UPDATE', [tripId]);
    if (!trips.length) {
      await conn.rollback();
      return { ok: false, code: 'trip_not_found' };
    }
    const trip = trips[0];
    if (!['SCHEDULED', 'BOARDING', 'DEPARTED', 'EN_ROUTE'].includes(trip.state)) {
      await conn.rollback();
      return { ok: false, code: 'trip_not_active', message: `This trip is ${trip.state}.` };
    }

    const [reqs] = await conn.query(
      'SELECT request_number, student_roll_number, pickup_location, dropoff_location, '
      + 'status, required_time FROM pickup_requests WHERE request_number = $1', [requestNumber]);
    const request = reqs[0];
    if (!request) {
      await conn.rollback();
      return { ok: false, code: 'request_not_found' };
    }
    if (String(request.student_roll_number) !== String(rollNumber)) {
      await conn.rollback();
      return { ok: false, code: 'not_yours', message: 'You can only join trips with your own request.' };
    }
    const [dupe] = await conn.query(
      'SELECT 1 FROM bus_assignments WHERE request_number = $1', [requestNumber]);
    if (dupe.length) {
      await conn.rollback();
      return { ok: false, code: 'already_assigned', message: 'This request already has a bus.' };
    }

    const [buses] = await conn.query(
      'SELECT max_capacity, current_count FROM buses WHERE bus_number = $1', [trip.bus_number]);
    const vehicle = buses[0];
    const [loads] = await conn.query(
      'SELECT COUNT(*)::int AS n FROM bus_assignments '
      + 'WHERE bus_number = $1 AND departure_time = $2', [trip.bus_number, trip.departure_time]);

    let gps, stops;
    if (trip.state === 'DEPARTED' || trip.state === 'EN_ROUTE') {
      const [fixes] = await conn.query(
        'SELECT lat, lng, recorded_at FROM trip_positions WHERE trip_id = $1 '
        + 'ORDER BY recorded_at DESC LIMIT 1', [tripId]);
      gps = { latest: fixes[0] || null, stale: isFixStale(fixes[0] || null, now) };
    }
    {
      const [stopRows] = await conn.query(
        'SELECT location_index, lat, lng FROM route_stops '
        + 'WHERE location_index IN ($1, $2, $3, $4) AND lat IS NOT NULL',
        [trip.route_pickup, trip.route_dropoff, request.pickup_location, request.dropoff_location]);
      stops = {};
      stopRows.forEach(s => { stops[s.location_index] = { lat: s.lat, lng: s.lng }; });
    }

    const gate = validateJoin({ request, trip, vehicle, depLoad: loads[0].n, gps, stops, now });
    if (!gate.ok) {
      await conn.rollback();
      return gate;
    }

    // FR-07: the atomic seat claim (re-verifies vehicle-level capacity).
    const [, claimed] = await conn.query(
      'UPDATE buses SET current_count = current_count + 1 '
      + 'WHERE bus_number = $1 AND current_count < max_capacity', [trip.bus_number]);
    if (claimed !== 1) {
      await conn.rollback();
      return { ok: false, code: 'departure_full', message: 'Vehicle filled just now — no seat left.' };
    }
    await conn.query(
      'INSERT INTO bus_assignments (request_number, bus_number, departure_time) VALUES ($1, $2, $3)',
      [requestNumber, trip.bus_number, trip.departure_time]);
    await conn.commit();
    return {
      ok: true,
      trip_id: tripId,
      bus_number: trip.bus_number,
      departure_time: new Date(trip.departure_time).toISOString(),
      state: trip.state,
      seats_left: Math.max(0, vehicle.max_capacity - loads[0].n - 1),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// True when the DB is missing a table (un-migrated production) — as opposed
// to being unreachable (an outage must surface, never degrade to a fake
// "empty board"). Exported pure for testing.
function isMissingTableError(e) {
  return /relation .* does not exist/i.test(String(e && e.message))
    || String(e && e.code) === '42P01';
}

module.exports = {
  coreLocationFromName, coreRouteIsValid,
  coreApproveRequest, coreRejectRequest, coreCompleteRequest,
  coreDispatchApprovedRequests, coreAssignApprovedRequests,
  coreRecordOccupancyEvent, coreTripLog, validateOccupancyEvent,
  planDispatch, parseRequiredTime, parseCampusLocal, campusTimeToDate,
  BOOKING_CUTOFF_MINUTES, ASSIGNABLE_VEHICLE_STATES, DEFAULT_DISPATCH_OPTIONS,
  CAMPUS_TZ_OFFSET_MINUTES, WALKABLE_VEHICLE_STATES,
  TRIP_STATES, canTransition, coreStartTrip, coreSetTripState, coreGetTrip,
  validateJoin, coreIngestPosition, coreActiveTrips, coreJoinTrip, JOIN_MAX_DELAY_MINUTES,
  isMissingTableError,
};
