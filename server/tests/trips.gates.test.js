// TEMP: live gate-checks for the trip lifecycle routes (Phase 3 steps 1-2).
// Boots the real app with an unreachable DB pool: anything that fails BEFORE
// a query returns its true status (proving auth/validation work); anything
// that reaches the DB 500s (proving it got past every guard).
const jwt = require('jsonwebtoken');

// Boot the app in-process (server.js only listens when run as main).
process.env.JWT_SECRET = 'trips-gate-secret';
process.env.SHUTTLE_DB_HOST = '127.0.0.1';
process.env.SHUTTLE_DB_PORT = '1';
process.env.SHUTTLE_DB_USER = 'u';
process.env.SHUTTLE_DB_NAME = 'd';
process.env.SHUTTLE_DB_PASS = 'p';
const app = require('../server.js');

const SECRET = process.env.JWT_SECRET;
const PORT = 3987;
const server = app.listen(PORT);

let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + ' -> ' + JSON.stringify(x || '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tokenFor = (role, extra = {}) => jwt.sign(
  role === 'student' ? { role, roll_number: 1, ...extra } : { role, name: 'T', ...extra },
  SECRET, { expiresIn: '1h' });

async function call(method, path, token, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

(async () => {
  await sleep(900);
  try {
    const scheduler = tokenFor('scheduler');
    const conductor = tokenFor('conductor');
    const guard = tokenFor('guard');
    const admin = tokenFor('admin');
    const student = tokenFor('student');

    // --- /api/trips/start gates ---
    let r = await call('POST', '/api/trips/start', null, { bus_number: 1, departure_time: '07:45' });
    check('no token -> 401', r.status === 401, r);
    r = await call('POST', '/api/trips/start', student, { bus_number: 1, departure_time: '07:45' });
    check('student -> 403', r.status === 403, r);
    r = await call('POST', '/api/trips/start', scheduler, { bus_number: 1, departure_time: '07:45' });
    check('scheduler excluded (conductor/guard/admin only) -> 403', r.status === 403, r);
    r = await call('POST', '/api/trips/start', admin, { bus_number: 1 });
    check('missing departure_time -> 400', r.status === 400, r);
    r = await call('POST', '/api/trips/start', admin, { departure_time: '07:45' });
    check('missing bus_number -> 400', r.status === 400, r);
    r = await call('POST', '/api/trips/start', admin, { bus_number: 1, departure_time: '07:45' });
    check('valid admin input reaches DB (500 = past guards)', r.status === 500, r);

    // --- /api/trips/:id/state gates ---
    r = await call('POST', '/api/trips/abc/state', conductor, { state: 'DEPARTED' });
    check('non-numeric id -> 400', r.status === 400, r);
    r = await call('POST', '/api/trips/1/state', conductor, { state: 'WARP' });
    check('unknown state -> 400', r.status === 400, r);
    r = await call('POST', '/api/trips/1/state', student, { state: 'DEPARTED' });
    check('student -> 403 on state route', r.status === 403, r);
    r = await call('POST', '/api/trips/1/state', guard, { state: 'departed' });
    check('lowercase state normalizes, reaches DB', r.status === 500, r);

    // --- /api/trips/current gates ---
    r = await call('GET', '/api/trips/current?bus_number=1', scheduler);
    check('missing departure_time -> 400', r.status === 400, r);
    r = await call('GET', '/api/trips/current?bus_number=1&departure_time=07:45', guard);
    check('bare HH:MM rejected with a helpful message', r.status === 400, r);
    r = await call('GET', '/api/trips/current?bus_number=1&departure_time=2026-09-15T07:45', scheduler);
    check('IST-naive timestamp accepted, reaches DB', r.status === 500, r);
    r = await call('GET', '/api/trips/current?bus_number=1&departure_time=2026-09-15T07:45:00Z', guard);
    check('ISO departure_time accepted, reaches DB', r.status === 500, r);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    server.close();
  }
})();
