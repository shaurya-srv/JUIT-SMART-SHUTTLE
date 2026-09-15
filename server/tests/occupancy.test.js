// Tests for the conductor-mode occupancy validator (pure core, no DB).
// Run: node server/tests/occupancy.test.js
const { validateOccupancyEvent, WALKABLE_VEHICLE_STATES } = require('../lib/service');

let failures = 0, passed = 0;
const check = (n, c, x) => {
  if (c) { passed++; console.log('PASS ' + n); }
  else { failures++; console.log('FAIL ' + n + '  -> ' + JSON.stringify(x)); }
};

const DEP = new Date('2026-09-15T02:15:00.000Z');
const veh = (over) => ({
  state: 'DISPATCHED', route_pickup: 1, route_dropoff: 0,
  current_count: 10, max_capacity: 30, ...over,
});
const ev = (over) => ({
  bus_number: 1, departure_time: DEP, event_type: 'WALK_IN',
  student_label: 'Aarav', ...over,
});

// ---- WR-01: only on an active trip ------------------------------------
check('1a. DISPATCHED vehicle accepts walk-in',
  validateOccupancyEvent(veh(), 5, ev()).ok === true);
check('1b. AVAILABLE vehicle rejected (trip not active)',
  validateOccupancyEvent(veh({ state: 'AVAILABLE' }), 5, ev()).error.includes('dispatched'));
check('1c. MAINTENANCE vehicle rejected',
  validateOccupancyEvent(veh({ state: 'MAINTENANCE' }), 5, ev()).ok === false);
check('1d. ON_TRIP accepted',
  validateOccupancyEvent(veh({ state: 'ON_TRIP' }), 5, ev()).ok === true);
check('1e. unknown vehicle rejected',
  validateOccupancyEvent(undefined, 5, ev()).error === 'vehicle not found');

// ---- WR-02: capacity guard --------------------------------------------
check('2a. walk-in within capacity ok',
  validateOccupancyEvent(veh(), 5, ev()).projected === 11);
check('2b. walk-in at capacity rejected',
  validateOccupancyEvent(veh({ current_count: 30 }), 5, ev()).error.includes('full'));
check('2c. walk-in when departure already full rejected (per-departure cap)',
  validateOccupancyEvent(veh(), 30, ev()).error.includes('departure is already full'));
check('2d. no-show releases a seat (delta -1)',
  validateOccupancyEvent(veh(), 5, ev({ event_type: 'NO_SHOW' })).seat_delta === -1);
check('2e. no-show at zero seats rejected (negative)',
  validateOccupancyEvent(veh({ current_count: 0 }), 0, ev({ event_type: 'NO_SHOW' })).error.includes('negative'));

// ---- event types / payload validation ----------------------------------
check('3a. bad event type rejected',
  validateOccupancyEvent(veh(), 5, ev({ event_type: 'FREE_RIDE' })).error.includes('event_type'));
check('3b. CHECK_IN ok with zero net delta',
  validateOccupancyEvent(veh(), 5, ev({ event_type: 'CHECK_IN' })).ok === true);
check('3c. ADJUSTMENT with zero delta rejected',
  validateOccupancyEvent(veh(), 5, ev({ event_type: 'ADJUSTMENT' })).error.includes('non-zero seat_delta'));
check('3d. ADJUSTMENT with delta accepted',
  validateOccupancyEvent(veh(), 5, ev({ event_type: 'ADJUSTMENT', seat_delta: 2 })).ok === true);
check('3e. bad departure_time rejected',
  validateOccupancyEvent(veh(), 5, ev({ departure_time: 'not-a-date' })).error.includes('departure_time'));
check('3f. walk-in without any student identity rejected (WR-06 input)',
  validateOccupancyEvent(veh(), 5, ev({ student_label: null })).error.includes('student'));

// ---- guardrails --------------------------------------------------------
check('4a. walkable states are exactly DISPATCHED/ON_TRIP',
  JSON.stringify(WALKABLE_VEHICLE_STATES) === JSON.stringify(['DISPATCHED', 'ON_TRIP']));
check('4b. no-show projects down not below via validator',
  validateOccupancyEvent(veh({ current_count: 1 }), 0, ev({ event_type: 'NO_SHOW' })).projected === 0);

console.log(failures ? `\n${failures} FAILURE(S), ${passed} passed` : `\nALL ${passed} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
