// Business rules — mirrors src/core/service.c
// Pure computation + DB orchestration. No HTTP, no console I/O.

const db = require('./db');
const { locationFromName, routeIsValid, LOC_COUNT, MAX_BUSES } = require('./models');

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

module.exports = {
  coreLocationFromName, coreRouteIsValid,
  coreApproveRequest, coreRejectRequest, coreCompleteRequest,
  coreDispatchApprovedRequests, coreAssignApprovedRequests,
  planDispatch, parseRequiredTime, parseCampusLocal, campusTimeToDate,
  BOOKING_CUTOFF_MINUTES, ASSIGNABLE_VEHICLE_STATES, DEFAULT_DISPATCH_OPTIONS,
  CAMPUS_TZ_OFFSET_MINUTES,
};
