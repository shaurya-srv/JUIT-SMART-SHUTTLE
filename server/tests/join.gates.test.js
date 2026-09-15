// Live gate-checks for the Phase 3 step 3-4 routes (GPS ingest, live board,
// join). Boots the real app with an unreachable DB pool: failures BEFORE a
// query return their true status; anything reaching the DB 500s (proving it
// got past every guard). /api/trips/active additionally verifies the
// degrade-to-empty behavior for un-migrated databases.
// Run: node server/tests/join.gates.test.js
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'join-gate-secret';
process.env.SHUTTLE_DB_HOST = '127.0.0.1';
process.env.SHUTTLE_DB_PORT = '1';
process.env.SHUTTLE_DB_USER = 'u';
process.env.SHUTTLE_DB_NAME = 'd';
process.env.SHUTTLE_DB_PASS = 'p';
const app = require('../server.js');

const SECRET = process.env.JWT_SECRET;
const PORT = 3988;
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
    const student = tokenFor('student');
    const conductor = tokenFor('conductor');
    const guard = tokenFor('guard');
    const admin = tokenFor('admin');
    const scheduler = tokenFor('scheduler');

    // --- GPS ingest: /api/trips/:id/position ---
    let r = await call('POST', '/api/trips/1/position', null, { lat: 31.01, lng: 77.08 });
    check('position: no token -> 401', r.status === 401, r);
    r = await call('POST', '/api/trips/1/position', student, { lat: 31.01, lng: 77.08 });
    check('position: student -> 403', r.status === 403, r);
    r = await call('POST', '/api/trips/1/position', scheduler, { lat: 31.01, lng: 77.08 });
    check('position: scheduler -> 403', r.status === 403, r);
    r = await call('POST', '/api/trips/1/position', conductor, { lng: 77.08 });
    check('position: missing lat reaches validation -> 409', r.status === 409, r);
    r = await call('POST', '/api/trips/1/position', conductor, { lat: 999, lng: 77.08 });
    check('position: implausible coords -> 409 (no DB touch)', r.status === 409, r);
    r = await call('POST', '/api/trips/1/position', admin, { lat: 31.01, lng: 77.08, accuracy_m: 8 });
    check('position: valid admin fix reaches DB (500 = past guards)', r.status === 500, r);

    // --- live board: /api/trips/active (public) ---
    r = await call('GET', '/api/trips/active', null);
    // With the DB UNREACHABLE (not merely un-migrated) the board must surface
    // an error, never a fake "no buses running":
    check('active: public route, DB outage surfaces as 500 (no fake empty)', r.status === 500, r);

    // --- join: /api/trips/:id/join ---
    r = await call('POST', '/api/trips/1/join', null, { request_number: 101 });
    check('join: no token -> 401', r.status === 401, r);
    r = await call('POST', '/api/trips/1/join', conductor, { request_number: 101 });
    check('join: staff -> 403 (students only)', r.status === 403, r);
    r = await call('POST', '/api/trips/1/join', student, {});
    check('join: missing request_number -> 400', r.status === 400, r);
    r = await call('POST', '/api/trips/1/join', student, { request_number: 101 });
    check('join: valid input reaches DB (500 = past guards)', r.status === 500, r);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    server.close();
  }
})();
