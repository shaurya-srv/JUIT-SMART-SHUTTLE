// Phase 3 steps 3-4 pure tests: join-running-bus validator (FR-17), GPS
// staleness (§7.18), dedupe window (§7.23), geometry sanity, and the
// missing-table vs outage error classification.
// Run: node server/tests/joinflow.test.js
const { validateJoin, isMissingTableError } = require('../lib/service');
const { stopPassed, isFixStale, withinDedupeWindow, plausibleFix, projectOntoSegment } = require('../lib/geo');

let failures = 0, passed = 0;
const check = (n, c, x) => {
  if (c) { passed++; console.log('PASS ' + n); }
  else { failures++; console.log('FAIL ' + n + '  -> ' + JSON.stringify(x)); }
};

// --- fixtures ---
// Route stops — JUIT, Ravli PG and Peach Tree are USER-VERIFIED pins
// (2026-09-15); Waknaghat is still the seed approximation.
//   0 JUIT gate (31.016747,77.073142) · 1 Ravli PG (31.015282,77.085094)
//   2 Peach Tree/Azad Bhavan ext (31.012071,77.086437)
//   3 Waknaghat (31.0055,77.0885 — approx)
const STOPS = {
  0: { lat: 31.016747, lng: 77.073142 },
  1: { lat: 31.015282, lng: 77.085094 },
  2: { lat: 31.012071, lng: 77.086437 },
  3: { lat: 31.0055, lng: 77.0885 },
};
const NOW = new Date('2026-09-15T03:00:00.000Z');            // 08:30 IST
const req = (over = {}) => ({
  request_number: 101, status: 'APPROVED',
  pickup_location: 2, dropoff_location: 0,                   // Peach Tree -> JUIT
  required_time: new Date(NOW.getTime() + 10 * 60 * 1000),
  ...over,
});
const trip = (over = {}) => ({
  trip_id: 1, bus_number: 1, route_pickup: 2, route_dropoff: 0,
  state: 'BOARDING', ...over,
});
const vehicle = { max_capacity: 30, current_count: 10 };
const freshGps = (over = {}) => ({
  latest: { lat: 31.0100, lng: 77.0830, recorded_at: new Date(NOW.getTime() - 10 * 1000), ...over },
  stale: false,
});
const base = (over = {}) => ({ request: req(), trip: trip(), vehicle, depLoad: 5, gps: freshGps(), stops: STOPS, now: NOW, ...over });

// --- happy path (boarding: no GPS needed at all) ---
check('boarding join ok without gps', validateJoin({ ...base(), gps: undefined }).ok);
check('boarding join ok without stops (index fallback)', validateJoin({ ...base(), stops: undefined }).ok);

// --- status gate ---
check('PENDING request rejected', validateJoin(base({ request: req({ status: 'PENDING_APPROVAL' }) })).code === 'not_approved');
check('COMPLETED request rejected', validateJoin(base({ request: req({ status: 'COMPLETED' }) })).code === 'not_approved');

// --- route gate: coordinate-driven (6.7 corridor membership) ---
check('exact route joins', validateJoin(base()).ok);
check(' Ravli student boards PeachTree->JUIT bus (corridor, 800m walk)', validateJoin(base({ request: req({ pickup_location: 1 }) })).ok);
check('reverse direction rejected', validateJoin(base({ request: req({ pickup_location: 0, dropoff_location: 2 }) })).code === 'route_mismatch');
// (Waknaghat-on-PT-bus is covered below: rejected by the end-bounds rule.)
check('dropoff beyond pickup rejected (JUIT->PeachTree on this bus)', validateJoin(base({ request: req({ dropoff_location: 3 }) })).code === 'route_mismatch');
// Real geometry (final pins): Waknaghat projects 532 m off the PT→JUIT chord
// and BEYOND its Peach Tree end (tRaw < 0) — the end-bounds rule must reject
// it even though it is within the 800 m walk tolerance.
check('Waknaghat student CANNOT board PT->JUIT bus (beyond end, 532m)', validateJoin(base({ request: req({ pickup_location: 3 }) })).code === 'route_mismatch');
check('unmapped stops fall back to strict index equality', validateJoin(base({ stops: undefined, request: req({ pickup_location: 1 }) })).code === 'route_mismatch');
// On the actual WK->JUIT run, a Waknaghat pickup rides t=0 → t=1: legal.
check('Waknaghat->JUIT rides the full WK->JUIT run', validateJoin(base({ request: req({ pickup_location: 3, dropoff_location: 0 }), trip: trip({ route_pickup: 3, route_dropoff: 0 }) })).ok);

// --- window gate (6.9): required_time may be at most 30 min past ---
check('required_time 10 min ahead ok', validateJoin(base()).ok);
check('required_time 29 min ago ok', validateJoin(base({ request: req({ required_time: new Date(NOW.getTime() - 29 * 60 * 1000) }) })).ok);
check('required_time 31 min ago rejected', validateJoin(base({ request: req({ required_time: new Date(NOW.getTime() - 31 * 60 * 1000) }) })).code === 'window_passed');
check('missing required_time ok (no window)', validateJoin(base({ request: req({ required_time: null }) })).ok);

// --- capacity gate ---
check('full departure rejected', validateJoin(base({ depLoad: 30 })).code === 'departure_full');
check('missing vehicle rejected', validateJoin(base({ vehicle: undefined })).code === 'vehicle_not_found');

// --- moving-bus gate (§7.18/§7.26) ---
const moving = (over = {}) => base({ trip: trip({ state: 'EN_ROUTE' }), ...over });
check('en-route with stale fix rejected', validateJoin(moving({ gps: { ...freshGps({ recorded_at: new Date(NOW.getTime() - 120 * 1000) }), stale: true } })).code === 'no_live_tracking');
check('en-route without gps rejected', validateJoin(moving({ gps: undefined })).code === 'no_live_tracking');
check('en-route unmapped stops fail SAFE', validateJoin(moving({ stops: undefined })).code === 'stop_coords_missing');
// On a linear route the origin stop is behind the bus the moment it moves:
// a bus at t≈0.1 on the real PT→JUIT chord has passed Peach Tree (t=0).
const busAt01 = freshGps({ lat: 31.012539, lng: 77.085108 });
check('origin-stop student rejected once bus moved', validateJoin(moving({ gps: busAt01 })).code === 'stop_already_passed');
// The Ravli student (t≈0.19 on the chord, real pin 282 m off) is ahead → joins.
check('mid-corridor student ahead of bus joins', validateJoin(moving({ gps: busAt01, request: req({ pickup_location: 1 }) })).ok);
// Bus past Ravli (t≈0.5) — now the Ravli student is behind too.
const busAt05 = freshGps({ lat: 31.014409, lng: 77.079789 });
check('mid-corridor student rejected once bus passed', validateJoin(moving({ gps: busAt05, request: req({ pickup_location: 1 }) })).code === 'stop_already_passed');
check('bus far off corridor rejected', validateJoin(moving({ gps: freshGps({ lat: 31.0500, lng: 77.1500 }) })).code === 'bus_off_route');
// DEPARTED runs the identical moving-bus gate (default fixture bus t≈0.09
// has left Peach Tree, so the Peach Tree student is rejected by it).
check('departed state uses same gate', validateJoin(base({ trip: trip({ state: 'DEPARTED' }) })).code === 'stop_already_passed');

// --- geometry directly ---
const A = { lat: 31.0092, lng: 77.0838 }, B = { lat: 31.0176, lng: 77.0735 };
check('projection t=0 at start', Math.abs(projectOntoSegment(A, A, B).t) < 0.001);
check('projection t=1 at end', Math.abs(projectOntoSegment(B, A, B).t - 1) < 0.001);
check('projection clamps beyond end', Math.abs(projectOntoSegment({ lat: 31.0200, lng: 77.0700 }, A, B).t - 1) < 0.001);
check('corridor distance ~0 on line', projectOntoSegment({ lat: 31.0134, lng: 77.0786 }, A, B).distanceM < 30);

// --- staleness & dedupe (§7.18/§7.23) ---
check('fresh fix not stale', !isFixStale({ recorded_at: new Date(NOW.getTime() - 60 * 1000) }, NOW));
check('91s-old fix stale', isFixStale({ recorded_at: new Date(NOW.getTime() - 91 * 1000) }, NOW));
check('null fix stale', isFixStale(null, NOW));
check('garbage timestamp stale', isFixStale({ recorded_at: 'nope' }, NOW));
check('3s gap deduped', withinDedupeWindow({ recorded_at: new Date(NOW.getTime() - 3000) }, NOW));
check('6s gap allowed', !withinDedupeWindow({ recorded_at: new Date(NOW.getTime() - 6000) }, NOW));
check('no last fix allowed', !withinDedupeWindow(null, NOW));

// --- coordinate sanity ---
check('campus coords plausible', plausibleFix({ lat: 31.01, lng: 77.08 }));
check('0,0 rejected', !plausibleFix({ lat: 0, lng: 0 }));
check('NaN rejected', !plausibleFix({ lat: NaN, lng: 77 }));
check('lat>90 rejected', !plausibleFix({ lat: 91, lng: 77 }));

// --- error classification: missing table degrades, outage surfaces ---
check('missing trips table detected', isMissingTableError(new Error('relation "trips" does not exist')));
check('pg 42P01 detected', isMissingTableError({ code: '42P01', message: 'x' }));
check('ECONNREFUSED is NOT missing-table', !isMissingTableError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }));
check('plain error is NOT missing-table', !isMissingTableError(new Error('boom')));

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
