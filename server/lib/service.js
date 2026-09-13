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

// Location rules
function coreLocationFromName(name) { return locationFromName(name); }
function coreRouteIsValid(p, d)     { return routeIsValid(p, d); }

// PRD 6.1 / FR-03 — validate a student-supplied required transport time.
// Pure function: returns { ok: true, date } or { ok: false, error } where
// error is one of 'invalid', 'past', 'cutoff'. Accepts Date or any value
// Date can parse; `now` is injectable for tests.
function parseRequiredTime(input, now = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
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

// Bus assignment algorithm
async function coreAssignApprovedRequests() {
  const result = {
    assigned_count: 0,
    skipped_already_assigned: 0,
    no_bus_available: 0,
    skipped_unavailable_vehicles: 0,
    warned_bus_numbers: [],
    warned_count: 0,
  };

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [buses] = await conn.query(
      'SELECT bus_number, route_pickup, route_dropoff, current_count, max_capacity, state '
      + 'FROM buses ORDER BY bus_number');
    // PRD 7.13: MAINTENANCE / OFFLINE / actively-dispatched vehicles are
    // never considered for automated assignment.
    const assignable = buses.filter(b => ASSIGNABLE_VEHICLE_STATES.includes(b.state));
    const [reqs] = await conn.query(
      'SELECT request_number, pickup_location, dropoff_location '
      + 'FROM pickup_requests WHERE status = $1 ORDER BY request_number', ['APPROVED']);

    for (const req of reqs) {
      // Check if already assigned
      const [assigned] = await conn.query(
        'SELECT COUNT(*)::int AS cnt FROM bus_assignments WHERE request_number = $1',
        [req.request_number]);
      if (assigned[0].cnt > 0) {
        result.skipped_already_assigned++;
        continue;
      }

      let placed = false;
      for (const bus of assignable) {
        if (bus.route_pickup === req.pickup_location &&
            bus.route_dropoff === req.dropoff_location &&
            bus.current_count < bus.max_capacity) {

          // Atomic: capacity-guarded increment. conn.query returns [rows, rowCount].
          const [, incCount] = await conn.query(
            'UPDATE buses SET current_count = current_count + 1 '
            + 'WHERE bus_number = $1 AND current_count < max_capacity',
            [bus.bus_number]);
          if (incCount !== 1) continue;

          await conn.query(
            'INSERT INTO bus_assignments (request_number, bus_number) VALUES ($1, $2)',
            [req.request_number, bus.bus_number]);

          bus.current_count++;
          result.assigned_count++;
          placed = true;

          // 80% capacity warning
          if (bus.max_capacity > 0 &&
              bus.current_count * 100 / bus.max_capacity >= 80) {
            if (!result.warned_bus_numbers.includes(bus.bus_number)) {
              result.warned_bus_numbers.push(bus.bus_number);
              result.warned_count++;
            }
          }
          break;
        }
      }
      if (!placed) result.no_bus_available++;
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  result.skipped_unavailable_vehicles = buses.length - assignable.length;
  return result;
}

module.exports = {
  coreLocationFromName, coreRouteIsValid,
  coreApproveRequest, coreRejectRequest, coreCompleteRequest,
  coreAssignApprovedRequests,
  parseRequiredTime, BOOKING_CUTOFF_MINUTES, ASSIGNABLE_VEHICLE_STATES,
};
