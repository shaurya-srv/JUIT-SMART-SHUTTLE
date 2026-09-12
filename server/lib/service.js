// Business rules — mirrors src/core/service.c
// Pure computation + DB orchestration. No HTTP, no console I/O.

const db = require('./db');
const { locationFromName, routeIsValid, LOC_COUNT, MAX_BUSES } = require('./models');

const CORE_MAX_REQUESTS = 512;

// Location rules
function coreLocationFromName(name) { return locationFromName(name); }
function coreRouteIsValid(p, d)     { return routeIsValid(p, d); }

// Request lifecycle transitions
async function coreApproveRequest(requestNumber) {
  const [rows] = await db.query(
    'SELECT status FROM pickup_requests WHERE request_number = $1', [requestNumber]);
  if (!rows.length || rows[0].status !== 'PENDING_APPROVAL') return false;
  const [result] = await db.query(
    'UPDATE pickup_requests SET status = $1 WHERE request_number = $2',
    ['APPROVED', requestNumber]);
  return result > 0;
}

async function coreRejectRequest(requestNumber) {
  const [rows] = await db.query(
    'SELECT status FROM pickup_requests WHERE request_number = $1', [requestNumber]);
  if (!rows.length || rows[0].status !== 'PENDING_APPROVAL') return false;
  const [result] = await db.query(
    'UPDATE pickup_requests SET status = $1 WHERE request_number = $2',
    ['REJECTED', requestNumber]);
  return result > 0;
}

// Bus assignment algorithm
async function coreAssignApprovedRequests() {
  const result = {
    assigned_count: 0,
    skipped_already_assigned: 0,
    no_bus_available: 0,
    warned_bus_numbers: [],
    warned_count: 0,
  };

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [buses] = await conn.query(
      'SELECT bus_number, route_pickup, route_dropoff, current_count, max_capacity '
      + 'FROM buses ORDER BY bus_number');
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
      for (const bus of buses) {
        if (bus.route_pickup === req.pickup_location &&
            bus.route_dropoff === req.dropoff_location &&
            bus.current_count < bus.max_capacity) {

          // Atomic: capacity-guarded increment
          const [inc] = await conn.query(
            'UPDATE buses SET current_count = current_count + 1 '
            + 'WHERE bus_number = $1 AND current_count < max_capacity',
            [bus.bus_number]);
          if (inc !== 1) continue;

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

  return result;
}

module.exports = {
  coreLocationFromName, coreRouteIsValid,
  coreApproveRequest, coreRejectRequest,
  coreAssignApprovedRequests,
};
