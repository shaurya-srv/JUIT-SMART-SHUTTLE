// Tests for the trip lifecycle's pure core: canTransition + the helper logic
// that surrounds it (state list, actor rules by contract). No DB.
// Run: node server/tests/trips.test.js
const { canTransition, TRIP_STATES } = require('../lib/service');

let failures = 0, passed = 0;
const check = (n, c, x) => {
  if (c) { passed++; console.log('PASS ' + n); }
  else { failures++; console.log('FAIL ' + n + '  -> ' + JSON.stringify(x)); }
};

// --- the happy path walks the full lifecycle ---
check('states are exactly the design set',
  JSON.stringify(TRIP_STATES) === JSON.stringify(['SCHEDULED','BOARDING','DEPARTED','EN_ROUTE','COMPLETED','CANCELLED']),
  TRIP_STATES);

const happy = [['SCHEDULED','BOARDING'], ['BOARDING','DEPARTED'], ['DEPARTED','EN_ROUTE'], ['EN_ROUTE','COMPLETED']];
happy.forEach(([from, to]) => {
  check(`${from} -> ${to} allowed`, canTransition(from, to).ok, canTransition(from, to));
});

// --- one-way discipline: no going back, no skipping ---
const rejections = [
  ['BOARDING', 'SCHEDULED', 'rewind'],
  ['DEPARTED', 'BOARDING', 'rewind'],
  ['EN_ROUTE', 'DEPARTED', 'rewind'],
  ['SCHEDULED', 'DEPARTED', 'skip boarding'],
  ['SCHEDULED', 'EN_ROUTE', 'skip'],
  ['BOARDING', 'EN_ROUTE', 'skip'],
  ['BOARDING', 'COMPLETED', 'skip'],
  ['DEPARTED', 'COMPLETED', 'skip'],
  ['SCHEDULED', 'COMPLETED', 'skip'],
];
rejections.forEach(([from, to, why]) => {
  check(`${from} -> ${to} rejected (${why})`, !canTransition(from, to).ok, canTransition(from, to));
});

// --- terminal states are terminal ---
check('COMPLETED -> anything rejected', !canTransition('COMPLETED', 'BOARDING').ok);
check('COMPLETED -> CANCELLED rejected', !canTransition('COMPLETED', 'CANCELLED').ok);
check('CANCELLED -> BOARDING rejected', !canTransition('CANCELLED', 'BOARDING').ok);
check('CANCELLED -> COMPLETED rejected', !canTransition('CANCELLED', 'COMPLETED').ok);
check('self-transition rejected (SCHEDULED)', !canTransition('SCHEDULED', 'SCHEDULED').ok);
check('self-transition rejected (EN_ROUTE)', !canTransition('EN_ROUTE', 'EN_ROUTE').ok);

// --- cancel is reachable from every non-terminal state ---
['SCHEDULED', 'BOARDING', 'DEPARTED', 'EN_ROUTE'].forEach(s =>
  check(`${s} -> CANCELLED allowed`, canTransition(s, 'CANCELLED').ok, canTransition(s, 'CANCELLED')));

// --- junk input ---
check('unknown from-state rejected', !canTransition('WARP', 'BOARDING').ok);
check('unknown to-state rejected', !canTransition('SCHEDULED', 'WARP').ok);
check('undefined inputs rejected', !canTransition(undefined, 'BOARDING').ok);
check('error messages are specific',
  canTransition('DEPARTED', 'COMPLETED').error === 'cannot move a DEPARTED trip to COMPLETED',
  canTransition('DEPARTED', 'COMPLETED'));

// --- the DB layer's validation contract: every TRIP_STATES value must pass
// the route-level uppercase whitelist; actors are enforced by requireRole ---
check('all states are uppercase alnum (route whitelist safe)',
  TRIP_STATES.every(s => /^[A-Z_]+$/.test(s)), TRIP_STATES);

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
