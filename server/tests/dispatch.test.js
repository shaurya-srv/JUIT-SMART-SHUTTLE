// TEMP: scenario tests for planDispatch (pure dispatch planner).
// Each scenario seeds fake vehicles/schedules/requests and asserts the
// decisions the PRD demands. Run: node server/_test_dispatch_temp.js
const {
  planDispatch, campusTimeToDate, parseCampusLocal, parseRequiredTime,
  DEFAULT_DISPATCH_OPTIONS,
} = require('../lib/service');

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + '  -> ' + JSON.stringify(extra)); }
}

// Fixed "now": Mon 2026-09-14 05:00 IST = Sun 2026-09-13 23:30 UTC
const NOW = new Date('2026-09-13T23:30:00Z');
const ist = iso => new Date(new Date(iso).getTime() + 330 * 60000).toISOString();

// Standard fixture: 3 buses (route 1->0) + 1 van (route 1->0), timetabled
const VEHICLES = [
  { bus_number: 1, route_pickup: 1, route_dropoff: 0, current_count: 0, max_capacity: 30, state: 'AVAILABLE', vehicle_type: 'bus' },
  { bus_number: 2, route_pickup: 1, route_dropoff: 0, current_count: 0, max_capacity: 30, state: 'AVAILABLE', vehicle_type: 'bus' },
  { bus_number: 3, route_pickup: 0, route_dropoff: 1, current_count: 0, max_capacity: 30, state: 'AVAILABLE', vehicle_type: 'bus' },
  { bus_number: 7, route_pickup: 1, route_dropoff: 0, current_count: 0, max_capacity: 12, state: 'AVAILABLE', vehicle_type: 'van' },
];
const SCHEDULES = [
  { bus_number: 1, departure_time: '07:45', label: 'Morning run · Mon-Sat' },
  { bus_number: 1, departure_time: '08:15', label: 'Morning run · Mon-Sat' },
  { bus_number: 2, departure_time: '07:45', label: 'Morning run · Mon-Sat' },
  { bus_number: 7, departure_time: '07:45', label: 'Sunday van · out' },
];

const REQ = (n, needIso, pickup = 1, dropoff = 0) =>
  ({ request_number: n, pickup_location: pickup, dropoff_location: dropoff, required_time: needIso ? new Date(needIso) : null, already_assigned: false });

function run(reqs, opts) {
  return planDispatch(reqs, VEHICLES, SCHEDULES, {}, NOW, opts || {});
}
const pick = (r, n) => r.decisions.find(d => d.request_number === n);

// ---- 1. basic fill: earliest feasible departure wins -------------------
let r = run([REQ(101, '2026-09-14T02:15:00Z')]); // 07:45 IST need
check('1. earliest feasible departure chosen (07:45, van preferred)',
  pick(r, 101).departure_time === '2026-09-14T02:15:00.000Z' && pick(r, 101).bus_number === 7, pick(r, 101));

// ---- 2. delay window respected (6.9) -----------------------------------
r = run([REQ(102, '2026-09-14T02:15:00Z')], { max_delay_minutes: 10 }); // 07:45+10 < 07:50 ok
check('2a. within delay window -> assigned to 07:45', pick(r, 102).status === 'assigned', r);
r = run([REQ(103, '2026-09-14T02:10:00Z')], { max_delay_minutes: 20 }); // need 07:40, 07:45 = +5 ok but 08:15 too late
check('2b. only 07:45 in window -> assigned (van preferred)', pick(r, 103).bus_number === 7 && ist(pick(r, 103).departure_time).slice(11, 16) === '07:45', pick(r, 103));
r = run([REQ(104, '2026-09-14T02:14:00Z')], { max_delay_minutes: 5 }); // need 07:44, 07:45 = +1 ok
check('2c. +1min delay ok', pick(r, 104).status === 'assigned', pick(r, 104));

// ---- 3. earliness window respected -------------------------------------
r = run([REQ(105, '2026-09-14T04:00:00Z')]); // need 09:30 IST; 07:45 is 105 min early -> out; 08:15 is 75 -> out; nothing
check('3. too-early departures rejected (no seat)', pick(r, 105).status === 'unassigned', pick(r, 105));

// ---- 4. wrong route never used -----------------------------------------
r = run([REQ(106, '2026-09-14T02:15:00Z', 0, 1)]); // needs JUIT->hostel; bus 3 has no timetable
check('4. route mismatch -> unassigned', pick(r, 106).status === 'unassigned', pick(r, 106));

// ---- 5. van preference at equal time (6.8) -----------------------------
r = run([REQ(107, '2026-09-14T02:15:00Z')]); // 07:45 candidates: bus1, bus2, van7
check('5. van preferred over equal-time bus (3-6 rule)',
  pick(r, 107).vehicle_type === 'van' && pick(r, 107).bus_number === 7, pick(r, 107));

// ---- 6. per-departure capacity -----------------------------------------
// van 7 capacity 12: fill it, next student rolls to a bus at same time
const crowd = [];
for (let i = 0; i < 13; i++) crowd.push(REQ(200 + i, '2026-09-14T02:15:00Z'));
r = run(crowd);
const vanAssigned = r.decisions.filter(d => d.bus_number === 7).length;
const firstBus = r.decisions.find(d => d.bus_number === 1);
check('6a. 12 seats on van, 13th rolls to bus', vanAssigned === 12 && !!firstBus, { vanAssigned, firstBus });
check('6b. all 13 assigned', r.assigned_count === 13, r.assigned_count);
check('6c. van trip shows 12/12', r.trips_used.find(t => t.bus_number === 7).seats_booked === 12, r.trips_used);

// ---- 7. existing trip load honored (re-runnable) -----------------------
r = run([REQ(300, '2026-09-14T02:15:00Z')], {});
const full = { '7|2026-09-14T02:15:00.000Z': 12 };
const r2 = planDispatch([REQ(300, '2026-09-14T02:15:00Z')], VEHICLES, SCHEDULES, full, NOW, {});
check('7. pre-loaded departure skipped, bus used instead',
  pick(r2, 300).bus_number === 1, pick(r2, 300));

// ---- 8. already-assigned skipped ---------------------------------------
r = run([{ ...REQ(301, '2026-09-14T02:15:00Z'), already_assigned: true }]);
check('8. already assigned -> skipped', r.skipped_already_assigned === 1 && r.assigned_count === 0, r);

// ---- 9. missing required_time ------------------------------------------
r = run([REQ(302, null)]);
check('9. legacy no-required_time -> unassigned with reason',
  r.missing_required_time === 1 && pick(r, 302).reason.includes('required time'), pick(r, 302));

// ---- 10. unavailable vehicle excluded (7.13) ---------------------------
const broken = VEHICLES.map(v => v.bus_number === 7 ? { ...v, state: 'MAINTENANCE' } : v);
const r3 = planDispatch([REQ(303, '2026-09-14T02:15:00Z')], broken, SCHEDULES, {}, NOW, {});
check('10. maintenance van never dispatched',
  pick(r3, 303).bus_number !== 7 && r3.skipped_unavailable_vehicles === 1, { d: pick(r3, 303), s: r3.skipped_unavailable_vehicles });

// ---- 11. earliest-deadline priority (6.5): constrained seat goes to urgent ----
// ONE seat left at 07:45. Request 401 (need 07:20) fits ONLY 07:45 (08:15
// would be +55 min > 30-min delay). Request 402 (need 08:20) fits both.
// Earliest-deadline-first means 401 gets the seat; a naive input-order or
// greedy-later policy would hand it to 402 and strand 401.
const pre = { '1|2026-09-14T02:15:00.000Z': 29, '7|2026-09-14T02:15:00.000Z': 12, '2|2026-09-14T02:15:00.000Z': 30 };
const compete = [
  REQ(402, '2026-09-14T02:50:00Z'), // need 08:20 — flexible (listed FIRST to prove ordering)
  REQ(401, '2026-09-14T01:50:00Z'), // need 07:20 — can only ride 07:45
];
const r4 = planDispatch(compete, VEHICLES, SCHEDULES, pre, NOW, {});
check('11. earliest deadline wins the constrained 07:45 seat',
  pick(r4, 401).bus_number === 1 && ist(pick(r4, 401).departure_time).slice(11, 16) === '07:45'
  && pick(r4, 402).bus_number === 1 && ist(pick(r4, 402).departure_time).slice(11, 16) === '08:15', { a: pick(r4, 401), b: pick(r4, 402) });

// ---- 12. departure that just left rolls to tomorrow (realism) ----------
const r5 = planDispatch(
  [REQ(403, '2026-09-14T05:30:00Z')], VEHICLES, SCHEDULES, {}, NOW, {});
// need 11:00 IST; 07:45/08:15 too early (>60min), nothing -> unassigned. Instead test "skip past" logic:
const now2 = new Date('2026-09-14T02:50:00Z'); // 08:20 IST: 07:45 gone, 08:15 leaving
const r6 = planDispatch([REQ(404, '2026-09-14T03:30:00Z')], VEHICLES, SCHEDULES, {}, now2, { max_earliness_minutes: 60 });
// need 09:00 IST; 08:15 departure is 5 min ago -> treated as gone; 07:45 too early -> unassigned
check('12. departed runs are not offered',
  pick(r6, 404).status === 'unassigned', pick(r6, 404));

// ---- 13. decision log completeness (7.10) ------------------------------
r = run([REQ(501, '2026-09-14T02:15:00Z'), REQ(502, null), REQ(503, '2026-09-14T04:00:00Z')]);
check('13. decision log covers every request',
  r.decisions.length === 3 && r.decisions.every(d => d.reason), r.decisions);

// ---- 14. campusTimeToDate sanity ---------------------------------------
const d1 = campusTimeToDate('07:45', NOW, 10);
check('14a. HH:MM IST -> correct UTC instant',
  d1.toISOString() === '2026-09-14T02:15:00.000Z', d1.toISOString());
const d2 = campusTimeToDate('07:45:00', new Date('2026-09-14T02:50:00Z'), 10); // 08:20 IST: 07:45 gone
check('14b. past departure rolls to next day',
  d2.toISOString() === '2026-09-15T02:15:00.000Z', d2.toISOString());

// ---- 15. parseCampusLocal / parseRequiredTime IST ----------------------
const p1 = parseCampusLocal('2026-09-14T09:00');
check('15a. naive datetime-local = IST',
  p1.ok && p1.date.toISOString() === '2026-09-14T03:30:00.000Z', p1.date && p1.date.toISOString());
const p2 = parseRequiredTime('2026-09-14T09:00', NOW); // 09:00 IST at 05:00 IST = 4h ahead
check('15b. cutoff accepts IST future', p2.ok === true, p2);
const p3 = parseRequiredTime('2026-09-14T05:10', NOW); // 05:10 IST = 10 min ahead < 30
check('15c. cutoff rejects inside window (IST)', p3.ok === false && p3.error === 'cutoff', p3);
const p4 = parseRequiredTime('2026-09-14T09:00+05:30', NOW);
check('15d. explicit offset respected', p4.ok === true, p4);

// ---- 16. determinism ----------------------------------------------------
const ra = run([REQ(601, '2026-09-14T02:15:00Z'), REQ(602, '2026-09-14T02:16:00Z')]);
const rb = run([REQ(602, '2026-09-14T02:16:00Z'), REQ(601, '2026-09-14T02:15:00Z')]);
check('16. order-independent plan',
  JSON.stringify(ra.decisions.map(d => [d.request_number, d.bus_number]))
  === JSON.stringify(rb.decisions.map(d => [d.request_number, d.bus_number])), { a: ra.decisions, b: rb.decisions });

console.log(failures ? `\n${failures} FAILURE(S), ${passed} passed` : `\nALL ${passed} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
