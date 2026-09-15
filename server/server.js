// JUIT Smart Shuttle — Node.js API server (PostgreSQL)
// Port of src/api/handlers.c + server.c to Express.js

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const db = require('./lib/db');
const { pwHash, pwVerify, randomBytes } = require('./lib/crypto');
const { clientIp, checkLoginAllowed, recordLoginFailure, clearLoginFailures } = require('./lib/ratelimit');
const {
  coreLocationFromName, coreRouteIsValid,
  coreApproveRequest, coreRejectRequest, coreCompleteRequest,
  coreDispatchApprovedRequests,
  parseRequiredTime, BOOKING_CUTOFF_MINUTES,
} = require('./lib/service');
const { LOCATIONS, MAX_BUS_CAPACITY } = require('./lib/models');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

app.use(cors());
app.use(express.json({ limit: '4kb' }));

// Express 4 does not catch rejected promises from async handlers — an unhandled
// rejection kills the process (fatal on Vercel serverless). Wrap every async
// route so errors fall through to the error middleware as a clean 500 instead.
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Note: On Vercel, static files (index.html) are served by Vercel's routing.
// The express.static middleware is only used for local development.

// ============================================================
// Auth middleware
// ============================================================

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing or invalid token' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    // Admin-managed passwords: a student still on the issued default can do
    // exactly one authenticated thing — change it. Everything else 403s
    // until the change is made (a fresh login then issues a clean token).
    if (payload.role === 'student' && payload.mcp
        && req.path !== '/api/students/password') {
      return res.status(403).json({ error: 'password change required', must_change_password: true });
    }
    req.session = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'missing or invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.session.role)) {
      return res.status(403).json({ error: `${roles.join(' or ')} role required` });
    }
    next();
  };
}

// ============================================================
// Public endpoints
// ============================================================

app.get('/api/health', ah(async (req, res) => {
  // db_host/db_user make "app is pointed at the wrong database" visible
  // instantly (hostnames/usernames are not secrets; the password never is).
  try {
    const [r] = await db.query('SELECT current_user AS db_user');
    res.json({
      status: 'ok',
      database: 'up',
      db_host: process.env.SHUTTLE_DB_HOST || '(default)',
      db_user: r[0].db_user,
    });
  } catch {
    res.json({
      status: 'ok',
      database: 'down',
      db_host: process.env.SHUTTLE_DB_HOST || '(default)',
    });
  }
}));

app.post('/api/login', ah(async (req, res) => {
  const { role, password, roll_number } = req.body;
  if (!role || !password) {
    return res.status(400).json({ error: 'role and password are required' });
  }

  // Brute-force guard (DB-backed, global across serverless instances):
  // 8 fails / 15 min per account, 30 / 15 min per source IP. Best-effort —
  // a limiter outage never locks the school out.
  let limiterAccount = null;
  try {
    if (role === 'student' && roll_number) {
      limiterAccount = ['student', String(roll_number)];
    } else if (['guard', 'scheduler', 'admin'].includes(role)) {
      limiterAccount = ['staff', role];
    }
    if (limiterAccount) {
      await checkLoginAllowed(limiterAccount[0], limiterAccount[1], clientIp(req));
    }
  } catch (e) {
    if (e.status === 429) {
      res.set('Retry-After', String(e.retryAfterSec || 900));
      return res.status(429).json({ error: e.message });
    }
    // Limiter DB error → allow the attempt (fail-open), never 500 the login.
  }
  const failLogin = async () => {
    if (limiterAccount) await recordLoginFailure(limiterAccount[0], limiterAccount[1], clientIp(req));
    return res.status(401).json({ error: 'invalid credentials' });
  };

  if (role === 'student') {
    if (!roll_number) {
      return res.status(400).json({ error: 'roll_number is required for students' });
    }
    const [rows] = await db.query(
      'SELECT password, name, must_change_password FROM students WHERE roll_number = $1', [roll_number]);
    if (!rows.length || !pwVerify(password, rows[0].password)) {
      return failLogin();
    }
    // Upgrade legacy plaintext
    if (!rows[0].password.startsWith('pbkdf2-sha256$')) {
      const hashed = pwHash(password);
      await db.query('UPDATE students SET password = $1 WHERE roll_number = $2', [hashed, roll_number]);
    }
    // Passwords are admin-managed: a student still on the imported default
    // gets one forced change at first login (frontend enforces the flow,
    // server enforces it again on every authenticated request).
    const mustChange = rows[0].must_change_password === true;
    await clearLoginFailures('student', String(roll_number));
    const token = jwt.sign({ role: 'student', roll_number, mcp: mustChange }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, role: 'student', roll_number, name: rows[0].name, must_change_password: mustChange });
  }

  if (role === 'guard' || role === 'scheduler' || role === 'admin') {
    const [rows] = await db.query(
      'SELECT password FROM credentials WHERE role = $1', [role]);
    if (!rows.length || !pwVerify(password, rows[0].password)) {
      return failLogin();
    }
    if (!rows[0].password.startsWith('pbkdf2-sha256$')) {
      const hashed = pwHash(password);
      await db.query('UPDATE credentials SET password = $1 WHERE role = $2', [hashed, role]);
    }
    await clearLoginFailures('staff', role);
    const token = jwt.sign({ role }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, role });
  }

  return res.status(400).json({ error: 'unknown role' });
}));

app.post('/api/register', ah(async (req, res) => {
  const { roll_number, name, room, hostel, phone, password } = req.body;
  if (!roll_number || !name || !room || !hostel || !phone || !password) {
    return res.status(400).json({ error: 'roll_number, name, room, hostel, phone and password are required' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'password must be at least 4 characters' });
  }
  const [exists] = await db.query('SELECT COUNT(*)::int AS cnt FROM students WHERE roll_number = $1', [roll_number]);
  if (exists[0].cnt > 0) {
    return res.status(409).json({ error: 'a student with this roll number already exists' });
  }
  const hashed = pwHash(password);
  await db.query(
    'INSERT INTO students (name, roll_number, room_number, hostel_name, phone_number, password) VALUES ($1,$2,$3,$4,$5,$6)',
    [name, roll_number, room, hostel, phone, hashed]);
  res.status(201).json({ registered: true });
}));

// SECURITY: the old unauthenticated POST /api/reset-password is gone.
// Knowing a roll number no longer lets anyone take over the account —
// password resets go through the admin (POST /api/admin/students/:roll/password),
// and students change their own password only while logged in (below).

// Student changes their own password (also satisfies the first-login
// forced change). Requires a fresh login — never takes the old password
// over an unauthenticated route.
app.put('/api/students/password', authenticate, requireRole('student'), ah(async (req, res) => {
  const { new_password } = req.body;
  if (!new_password) {
    return res.status(400).json({ error: 'new_password is required' });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  const [, rowCount] = await db.query(
    'UPDATE students SET password = $1, must_change_password = FALSE, password_changed_at = now() '
    + 'WHERE roll_number = $2',
    [pwHash(new_password), req.session.roll_number]);
  if (!rowCount) return res.status(404).json({ error: 'student not found' });
  res.json({ changed: true });
}));

// ============================================================
// Authenticated endpoints
// ============================================================

app.post('/api/requests', authenticate, requireRole('student'), ah(async (req, res) => {
  const { pickup_place, dropoff_place, required_time } = req.body;
  if (!pickup_place || !dropoff_place) {
    return res.status(400).json({ error: 'pickup_place and dropoff_place are required' });
  }
  const p = coreLocationFromName(pickup_place);
  const d = coreLocationFromName(dropoff_place);
  if (!coreRouteIsValid(p, d)) {
    return res.status(400).json({ error: 'unknown pickup/dropoff or same-location route' });
  }

  // PRD 6.1 / FR-03: when a required transport time is given, it must be at
  // least 30 minutes ahead (the planning window). Optional for now — legacy
  // flows without a time keep working until the booking-slot rollout.
  let neededAt = null;
  if (required_time !== undefined && required_time !== null && required_time !== '') {
    const check = parseRequiredTime(required_time);
    if (!check.ok) {
      if (check.error === 'invalid') return res.status(400).json({ error: 'required_time is not a valid date/time' });
      if (check.error === 'past') return res.status(400).json({ error: 'required_time is already in the past' });
      return res.status(400).json({ error: `book at least ${BOOKING_CUTOFF_MINUTES} minutes ahead of the required time` });
    }
    neededAt = check.date.toISOString();
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [maxRow] = await conn.query('SELECT COALESCE(MAX(request_number),0)+1 AS rn FROM pickup_requests');
    const rn = maxRow[0].rn;
    const dir = p < d ? 1 : -1;
    await conn.query(
      'INSERT INTO pickup_requests (request_number, student_roll_number, pickup_place, dropoff_place, '
      + 'pickup_location, dropoff_location, direction, required_time, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [rn, req.session.roll_number, pickup_place, dropoff_place, p, d, dir, neededAt, 'PENDING_APPROVAL']);
    await conn.commit();
    res.status(201).json({ request_number: rn, status: 'PENDING_APPROVAL', required_time: neededAt });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'could not create request' });
  } finally {
    conn.release();
  }
}));

app.get('/api/requests/mine', authenticate, requireRole('student'), ah(async (req, res) => {
  const [rows] = await db.query(
    'SELECT r.request_number, s.name AS student_name, s.roll_number AS student_roll_number, '
    + 's.hostel_name, s.room_number, s.phone_number, r.pickup_place, r.dropoff_place, r.status, r.required_time '
    + 'FROM pickup_requests r JOIN students s ON r.student_roll_number = s.roll_number '
    + 'WHERE r.student_roll_number = $1 ORDER BY r.request_number DESC', [req.session.roll_number]);

  // Batch-fill bus assignments
  const [assigns] = await db.query(
    'SELECT a.request_number, a.bus_number, a.departure_time, b.vehicle_type '
    + 'FROM bus_assignments a LEFT JOIN buses b ON a.bus_number = b.bus_number');
  const assignMap = {};
  assigns.forEach(a => assignMap[a.request_number] = {
    bus: a.bus_number, departure: a.departure_time || null, vehicle_type: a.vehicle_type || 'bus',
  });

  const result = rows.map(r => {
    const a = assignMap[r.request_number] || {};
    return {
      request_number: r.request_number,
      student_name: r.student_name,
      roll_number: r.student_roll_number,
      hostel: r.hostel_name,
      room: r.room_number,
      phone: r.phone_number,
      pickup: r.pickup_place,
      dropoff: r.dropoff_place,
      status: r.status,
      required_time: r.required_time,
      bus: a.bus || 0,
      departure: a.departure || null,
      vehicle_type: a.vehicle_type || 'bus',
      departure_label: a.departure
        ? new Date(a.departure).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
        : null,
    };
  });

  res.json({ count: result.length, requests: result });
}));

app.get('/api/requests', authenticate, requireRole('guard', 'scheduler'), ah(async (req, res) => {
  let query = 'SELECT r.request_number, s.name AS student_name, s.roll_number AS student_roll_number, '
    + 's.hostel_name, s.room_number, s.phone_number, r.pickup_place, r.dropoff_place, r.status, r.required_time '
    + 'FROM pickup_requests r JOIN students s ON r.student_roll_number = s.roll_number';
  const params = [];
  let paramIdx = 1;

  if (req.query.status) {
    const status = req.query.status;
    if (!['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'status must be PENDING_APPROVAL, APPROVED or REJECTED' });
    }
    query += ` WHERE r.status = $${paramIdx++}`;
    params.push(status);
  }
  query += ' ORDER BY r.request_number';

  const [rows] = await db.query(query, params);
  const [assigns] = await db.query(
    'SELECT a.request_number, a.bus_number, a.departure_time, b.vehicle_type '
    + 'FROM bus_assignments a LEFT JOIN buses b ON a.bus_number = b.bus_number');
  const assignMap = {};
  assigns.forEach(a => assignMap[a.request_number] = {
    bus: a.bus_number, departure: a.departure_time || null, vehicle_type: a.vehicle_type || 'bus',
  });

  const result = rows.map(r => {
    const a = assignMap[r.request_number] || {};
    return {
      request_number: r.request_number,
      student_name: r.student_name,
      roll_number: r.student_roll_number,
      hostel: r.hostel_name,
      room: r.room_number,
      phone: r.phone_number,
      pickup: r.pickup_place,
      dropoff: r.dropoff_place,
      status: r.status,
      required_time: r.required_time,
      bus: a.bus || 0,
      departure: a.departure || null,
      vehicle_type: a.vehicle_type || 'bus',
      departure_label: a.departure
        ? new Date(a.departure).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
        : null,
    };
  });

  res.json({ count: result.length, requests: result });
}));

app.post('/api/requests/:id/approve', authenticate, requireRole('guard'), ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const ok = await coreApproveRequest(id);
  if (!ok) {
    const [rows] = await db.query('SELECT status FROM pickup_requests WHERE request_number = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'request not found' });
    return res.status(409).json({ error: 'request is not pending' });
  }
  res.json({ request_number: id, status: 'APPROVED' });
}));

app.post('/api/requests/:id/reject', authenticate, requireRole('guard'), ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const ok = await coreRejectRequest(id);
  if (!ok) {
    const [rows] = await db.query('SELECT status FROM pickup_requests WHERE request_number = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'request not found' });
    return res.status(409).json({ error: 'request is not pending' });
  }
  res.json({ request_number: id, status: 'REJECTED' });
}));

app.post('/api/requests/:id/complete', authenticate, requireRole('guard', 'admin'), ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const ok = await coreCompleteRequest(id);
  if (!ok) {
    const [rows] = await db.query('SELECT status FROM pickup_requests WHERE request_number = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'request not found' });
    return res.status(409).json({ error: 'request is not approved (only approved rides can be completed)' });
  }
  res.json({ request_number: id, status: 'COMPLETED' });
}));

app.get('/api/buses', authenticate, requireRole('scheduler', 'admin'), ah(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM buses ORDER BY bus_number');
  const result = rows.map(b => ({
    bus_number: b.bus_number,
    route: `${LOCATIONS[b.route_pickup]} -> ${LOCATIONS[b.route_dropoff]}`,
    route_pickup: b.route_pickup,
    route_dropoff: b.route_dropoff,
    assigned: b.current_count,
    capacity: b.max_capacity,
    vehicle_type: b.vehicle_type || 'bus',
    state: b.state || 'AVAILABLE',
  }));
  res.json({ count: result.length, buses: result });
}));

app.post('/api/buses', authenticate, requireRole('scheduler', 'admin'), ah(async (req, res) => {
  const { route_pickup, route_dropoff, max_capacity, vehicle_type } = req.body;
  if (route_pickup == null || route_dropoff == null || max_capacity == null) {
    return res.status(400).json({ error: 'route_pickup, route_dropoff and max_capacity are required' });
  }
  if (!coreRouteIsValid(route_pickup, route_dropoff)) {
    return res.status(400).json({ error: 'invalid route (0=JUIT,1=Ravli PG,2=Peach Tree,3=Waknaghat)' });
  }
  if (max_capacity < 1 || max_capacity > MAX_BUS_CAPACITY) {
    return res.status(400).json({ error: 'max_capacity must be 1-30' });
  }
  // PRD 6.8: vehicle sizing — van (small groups) vs bus. Defaults to bus.
  const vType = vehicle_type === undefined || vehicle_type === null ? 'bus' : vehicle_type;
  if (!['bus', 'van'].includes(vType)) {
    return res.status(400).json({ error: 'vehicle_type must be bus or van' });
  }
  const [maxRow] = await db.query('SELECT COALESCE(MAX(bus_number),0)+1 AS bn FROM buses');
  const bn = maxRow[0].bn;
  await db.query(
    'INSERT INTO buses (bus_number, route_pickup, route_dropoff, current_count, max_capacity, vehicle_type) VALUES ($1,$2,$3,$4,$5,$6)',
    [bn, route_pickup, route_dropoff, 0, max_capacity, vType]);
  res.status(201).json({
    bus_number: bn, route_pickup, route_dropoff, max_capacity, vehicle_type: vType,
  });
}));

// PRD 7.13: operational state transitions. Only AVAILABLE vehicles are
// picked by auto-assign; MAINTENANCE / OFFLINE / DISPATCHED / ON_TRIP are
// skipped by the assignment algorithm.
app.patch('/api/buses/:bus_number/state', authenticate, requireRole('scheduler', 'admin'), ah(async (req, res) => {
  const bn = parseInt(req.params.bus_number);
  const { state } = req.body;
  if (!bn || !state) {
    return res.status(400).json({ error: 'bus_number and state are required' });
  }
  const STATES = ['AVAILABLE', 'DISPATCHED', 'ON_TRIP', 'MAINTENANCE', 'OFFLINE'];
  if (!STATES.includes(state)) {
    return res.status(400).json({ error: `state must be one of: ${STATES.join(', ')}` });
  }
  const [, rowCount] = await db.query('UPDATE buses SET state = $1 WHERE bus_number = $2', [state, bn]);
  if (!rowCount) return res.status(404).json({ error: 'bus not found' });
  res.json({ bus_number: bn, state });
}));

// Dispatch engine v1 (FR-09/10/11): pools approved requests by route +
// deadline, fills scheduled departures first, sizes van vs bus, enforces the
// delay/earliness windows, and returns a per-request decision log (7.10).
// Optional body: { max_delay_minutes, max_earliness_minutes } — defaults 30/60.
app.post('/api/buses/assign', authenticate, requireRole('scheduler', 'admin'), ah(async (req, res) => {
  try {
    const options = {};
    if (req.body && req.body.max_delay_minutes !== undefined) {
      options.maxDelayMinutes = Number(req.body.max_delay_minutes);
    }
    if (req.body && req.body.max_earliness_minutes !== undefined) {
      options.maxEarlinessMinutes = Number(req.body.max_earliness_minutes);
    }
    const result = await coreDispatchApprovedRequests(options);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'database error during dispatch' });
  }
}));

app.post('/api/assignments/unassign', authenticate, requireRole('scheduler', 'admin'), ah(async (req, res) => {
  const { request_number } = req.body;
  if (!request_number) {
    return res.status(400).json({ error: 'request_number is required' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT bus_number FROM bus_assignments WHERE request_number = $1', [request_number]);
    if (!rows.length) {
      await conn.rollback();
      const [exists] = await db.query('SELECT COUNT(*)::int AS cnt FROM pickup_requests WHERE request_number = $1', [request_number]);
      if (exists[0].cnt === 0) return res.status(404).json({ error: 'request not found' });
      return res.status(404).json({ error: 'request is not assigned to a bus' });
    }
    const bn = rows[0].bus_number;
    await conn.query('DELETE FROM bus_assignments WHERE request_number = $1', [request_number]);
    await conn.query('UPDATE buses SET current_count = current_count - 1 WHERE bus_number = $1 AND current_count > 0', [bn]);
    await conn.commit();
    res.json({ request_number, assigned: false });
  } catch {
    await conn.rollback();
    res.status(500).json({ error: 'unassign failed' });
  } finally {
    conn.release();
  }
}));

app.get('/api/reports/capacity', authenticate, requireRole('guard', 'scheduler', 'admin'), ah(async (req, res) => {
  const [rows] = await db.query(
    'SELECT route_pickup, route_dropoff, SUM(max_capacity)::int AS capacity, '
    + 'SUM(current_count)::int AS assigned, COUNT(*)::int AS buses '
    + 'FROM buses GROUP BY route_pickup, route_dropoff');

  const result = rows.map(r => ({
    route: `${LOCATIONS[r.route_pickup]} -> ${LOCATIONS[r.route_dropoff]}`,
    buses: r.buses,
    assigned: r.assigned,
    capacity: r.capacity,
    available: r.capacity - r.assigned,
  }));

  res.json({ count: result.length, routes: result });
}));

// ============================================================
// Timetable endpoints
// ============================================================

// Timetable payload shared by the authenticated and public endpoints.
async function timetablePayload() {
  const [rows] = await db.query(
    'SELECT s.schedule_id, s.bus_number, s.departure_time, s.label, '
    + 'b.route_pickup, b.route_dropoff, b.current_count, b.max_capacity, b.vehicle_type '
    + 'FROM bus_schedules s JOIN buses b ON s.bus_number = b.bus_number '
    + 'ORDER BY s.departure_time, s.bus_number');
  const schedule = rows.map(r => ({
    schedule_id: r.schedule_id,
    bus_number: r.bus_number,
    departure_time: String(r.departure_time).slice(0, 5),
    label: r.label,
    route: `${LOCATIONS[r.route_pickup]} → ${LOCATIONS[r.route_dropoff]}`,
    seats_available: r.max_capacity - r.current_count,
    max_capacity: r.max_capacity,
    vehicle_type: r.vehicle_type || (/van/i.test(r.label || '') ? 'van' : 'bus'),
  }));
  return { count: schedule.length, schedule };
}

// Public to any authenticated user — students need it to plan ahead.
app.get('/api/timetable', authenticate, ah(async (req, res) => {
  res.json(await timetablePayload());
}));

// Public snapshot — no auth, so students can check today's departures and
// live seat counts from the login screen (e.g. at the hostel gate).
// Read-only; exposes only times, routes, labels and seat counts — never
// student or request data.
app.get('/api/timetable/public', ah(async (req, res) => {
  res.json(await timetablePayload());
}));

app.post('/api/timetable', authenticate, requireRole('scheduler', 'admin'), ah(async (req, res) => {
  const { bus_number, departure_time, label } = req.body;
  const t = typeof departure_time === 'string' ? departure_time.trim() : '';
  if (!bus_number || !/^\d{1,2}:\d{2}$/.test(t)) {
    return res.status(400).json({ error: 'bus_number and departure_time (HH:MM) are required' });
  }
  const [h, m] = t.split(':').map(Number);
  if (h > 23 || m > 59) {
    return res.status(400).json({ error: 'departure_time must be a valid HH:MM time' });
  }
  const [exists] = await db.query('SELECT COUNT(*)::int AS cnt FROM buses WHERE bus_number = $1', [bus_number]);
  if (!exists[0].cnt) {
    return res.status(404).json({ error: 'bus not found' });
  }
  const [dupe] = await db.query(
    'SELECT COUNT(*)::int AS cnt FROM bus_schedules WHERE bus_number = $1 AND departure_time = $2',
    [bus_number, t]);
  if (dupe[0].cnt) {
    return res.status(409).json({ error: 'this bus already has a departure at that time' });
  }
  const [ins] = await db.query(
    'INSERT INTO bus_schedules (bus_number, departure_time, label) VALUES ($1, $2, $3) RETURNING schedule_id',
    [bus_number, t, label || null]);
  res.status(201).json({ schedule_id: ins[0].schedule_id, bus_number, departure_time: t, label: label || null });
}));

app.delete('/api/timetable/:id', authenticate, requireRole('scheduler', 'admin'), ah(async (req, res) => {
  const [, rowCount] = await db.query('DELETE FROM bus_schedules WHERE schedule_id = $1', [parseInt(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'schedule entry not found' });
  res.json({ deleted: true });
}));

// ============================================================
// Admin: staff credential management
// ============================================================

app.get('/api/admin/staff', authenticate, requireRole('admin'), ah(async (req, res) => {
  const [rows] = await db.query(
    "SELECT role, CASE WHEN password LIKE 'pbkdf2-sha256$%' THEN 'hashed' ELSE 'plaintext' END AS password_state FROM credentials ORDER BY role");
  res.json({ count: rows.length, staff: rows });
}));

app.post('/api/admin/staff-password', authenticate, requireRole('admin'), ah(async (req, res) => {
  const { role, new_password } = req.body;
  if (!role || !new_password) {
    return res.status(400).json({ error: 'role and new_password are required' });
  }
  if (!['guard', 'scheduler', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be guard, scheduler or admin' });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  const [, rowCount] = await db.query(
    'UPDATE credentials SET password = $1 WHERE role = $2', [pwHash(new_password), role]);
  if (!rowCount) return res.status(404).json({ error: 'role not found' });
  res.json({ role, updated: true });
}));

// ============================================================
// Admin: student account management (mass import + password resets).
// The only path students ever get or regain a password.
// ============================================================

app.get('/api/admin/students', authenticate, requireRole('admin'), ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const [rows] = q
    ? await db.query(
        'SELECT roll_number, name, room_number, hostel_name, phone_number, must_change_password, password_changed_at '
        + 'FROM students WHERE roll_number::text LIKE $1 OR name ILIKE $2 '
        + 'ORDER BY roll_number LIMIT $3',
        [q + '%', '%' + q + '%', limit])
    : await db.query(
        'SELECT roll_number, name, room_number, hostel_name, phone_number, must_change_password, password_changed_at '
        + 'FROM students ORDER BY roll_number LIMIT $1', [limit]);
  const [totals] = await db.query(
    'SELECT COUNT(*)::int AS total, '
    + "COUNT(*) FILTER (WHERE must_change_password)::int AS on_default_password FROM students");
  res.json({
    count: rows.length,
    total: totals[0].total,
    on_default_password: totals[0].on_default_password,
    students: rows.map(r => ({
      roll_number: r.roll_number,
      name: r.name,
      room: r.room_number,
      hostel: r.hostel_name,
      phone: r.phone_number,
      on_default_password: r.must_change_password === true,
      password_changed_at: r.password_changed_at,
    })),
  });
}));

const MAX_IMPORT_STUDENTS = 1000;

// Bulk-import students with a shared default password they must replace
// at first login. Existing roll numbers are skipped (never overwritten).
app.post('/api/admin/students', authenticate, requireRole('admin'), ah(async (req, res) => {
  const { students, default_password } = req.body || {};
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: 'students array is required' });
  }
  if (students.length > MAX_IMPORT_STUDENTS) {
    return res.status(400).json({ error: `import at most ${MAX_IMPORT_STUDENTS} students at a time` });
  }
  if (default_password !== undefined && String(default_password).length < 8) {
    return res.status(400).json({ error: 'default_password must be at least 8 characters' });
  }

  const seen = new Set();
  const clean = [];
  for (const s of students) {
    const roll = parseInt(s && s.roll_number, 10);
    const name = String((s && s.name) || '').trim();
    const room = String((s && s.room) || '').trim();
    const hostel = String((s && s.hostel) || '').trim();
    const phone = String((s && s.phone) || '').trim();
    if (!roll || roll < 1) {
      return res.status(400).json({ error: `invalid roll_number in import list: ${JSON.stringify(s && s.roll_number)}` });
    }
    if (!name || name.length > 100 || room.length > 20 || hostel.length > 50 || phone.length > 20) {
      return res.status(400).json({ error: `invalid or too-long fields for roll number ${roll}` });
    }
    if (seen.has(roll)) {
      return res.status(400).json({ error: `duplicate roll number in import list: ${roll}` });
    }
    seen.add(roll);
    clean.push([roll, name, room, hostel, phone]);
  }

  // One hash for everyone: the default is shared by design, and hashing
  // per row would blow the serverless time budget on large imports.
  const hash = pwHash(default_password || 'Pass@' + new Date().getFullYear());
  const values = [];
  const tuples = clean.map((row, i) => {
    values.push(...row);
    const b = i * 5;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$6,TRUE)`;
  });
  const [, rowCount] = await db.query(
    'INSERT INTO students (roll_number, name, room_number, hostel_name, phone_number, password, must_change_password) '
    + 'VALUES ' + tuples.join(',')
    + ' ON CONFLICT (roll_number) DO NOTHING',
    values);
  const imported = rowCount || 0;
  res.status(201).json({
    imported,
    skipped_existing: clean.length - imported,
    default_password_used: default_password ? '(as provided)' : '(generated default)',
  });
}));

// Admin resets one student's password: sets the default back and forces a
// change at next login. This is THE forgot-password flow.
app.post('/api/admin/students/:roll/password', authenticate, requireRole('admin'), ah(async (req, res) => {
  const { new_password } = req.body || {};
  const roll = parseInt(req.params.roll, 10);
  if (!roll) return res.status(400).json({ error: 'invalid roll number' });
  if (new_password !== undefined && String(new_password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  const hash = pwHash(new_password || 'Pass@' + new Date().getFullYear());
  const [, rowCount] = await db.query(
    'UPDATE students SET password = $1, must_change_password = TRUE WHERE roll_number = $2',
    [hash, roll]);
  if (!rowCount) return res.status(404).json({ error: 'student not found' });
  res.json({ roll, reset: true, must_change_password: true });
}));

// Brute-force monitor: which identities are racking up failures or are
// actively blocked. Admin-only; read-only plus explicit unblock.
app.get('/api/admin/login-failures', authenticate, requireRole('admin'), ah(async (req, res) => {
  const [rows] = await db.query(
    'SELECT identity_key, fail_count, window_start, blocked_until '
    + 'FROM login_failures WHERE fail_count > 0 OR blocked_until IS NOT NULL '
    + 'ORDER BY COALESCE(blocked_until, window_start) DESC LIMIT 100');
  const now = Date.now();
  const entries = rows.map(r => {
    const blocked = r.blocked_until && new Date(r.blocked_until).getTime() > now;
    const key = String(r.identity_key || '');
    return {
      identity_key: key,
      kind: key.startsWith('ip:') ? 'ip' : key.split(':')[0],
      id: key.includes(':') ? key.slice(key.indexOf(':') + 1) : key,
      fail_count: r.fail_count,
      window_start: r.window_start,
      blocked_until: blocked ? r.blocked_until : null,
      blocked: !!blocked,
    };
  });
  res.json({
    count: entries.length,
    blocked_count: entries.filter(e => e.blocked).length,
    entries,
  });
}));

// Admin unblock: clears one identity's counter entirely.
app.delete('/api/admin/login-failures/:key', authenticate, requireRole('admin'), ah(async (req, res) => {
  const key = String(req.params.key || '');
  if (!/^(student|staff|ip):[A-Za-z0-9._:-]{1,60}$/.test(key)) {
    return res.status(400).json({ error: 'invalid identity key' });
  }
  const [, rowCount] = await db.query('DELETE FROM login_failures WHERE identity_key = $1', [key]);
  if (!rowCount) return res.status(404).json({ error: 'identity not found (it may have already expired)' });
  res.json({ cleared: key });
}));

// Central error handler — target of the ah() wrapper above.
app.use((err, req, res, next) => {
  console.error(`API error ${req.method} ${req.path}: ${err.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

// ============================================================
// Start server
// ============================================================

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`shuttle_api listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;
