// JUIT Smart Shuttle — Node.js API server (PostgreSQL)
// Port of src/api/handlers.c + server.c to Express.js

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const db = require('./lib/db');
const { pwHash, pwVerify, randomBytes } = require('./lib/crypto');
const {
  coreLocationFromName, coreRouteIsValid,
  coreApproveRequest, coreRejectRequest,
  coreAssignApprovedRequests,
} = require('./lib/service');
const { LOCATIONS, MAX_BUS_CAPACITY } = require('./lib/models');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

app.use(cors());
app.use(express.json({ limit: '4kb' }));

// Serve static frontend
app.use(express.static(__dirname + '/..'));

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

app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'up' });
  } catch {
    res.json({ status: 'ok', database: 'down' });
  }
});

app.post('/api/login', async (req, res) => {
  const { role, password, roll_number } = req.body;
  if (!role || !password) {
    return res.status(400).json({ error: 'role and password are required' });
  }

  if (role === 'student') {
    if (!roll_number) {
      return res.status(400).json({ error: 'roll_number is required for students' });
    }
    const [rows] = await db.query(
      'SELECT password, name FROM students WHERE roll_number = $1', [roll_number]);
    if (!rows.length || !pwVerify(password, rows[0].password)) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    // Upgrade legacy plaintext
    if (!rows[0].password.startsWith('pbkdf2-sha256$')) {
      const hashed = pwHash(password);
      await db.query('UPDATE students SET password = $1 WHERE roll_number = $2', [hashed, roll_number]);
    }
    const token = jwt.sign({ role: 'student', roll_number }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, role: 'student', roll_number, name: rows[0].name });
  }

  if (role === 'guard' || role === 'scheduler') {
    const [rows] = await db.query(
      'SELECT password FROM credentials WHERE role = $1', [role]);
    if (!rows.length || !pwVerify(password, rows[0].password)) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (!rows[0].password.startsWith('pbkdf2-sha256$')) {
      const hashed = pwHash(password);
      await db.query('UPDATE credentials SET password = $1 WHERE role = $2', [hashed, role]);
    }
    const token = jwt.sign({ role }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, role });
  }

  return res.status(400).json({ error: 'unknown role' });
});

app.post('/api/register', async (req, res) => {
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
});

app.post('/api/reset-password', async (req, res) => {
  const { roll_number, new_password } = req.body;
  if (!roll_number || !new_password) {
    return res.status(400).json({ error: 'roll_number and new_password are required' });
  }
  if (new_password.length < 4) {
    return res.status(400).json({ error: 'password must be at least 4 characters' });
  }
  const [exists] = await db.query('SELECT COUNT(*)::int AS cnt FROM students WHERE roll_number = $1', [roll_number]);
  if (exists[0].cnt === 0) {
    return res.status(404).json({ error: 'student not found' });
  }
  const hashed = pwHash(new_password);
  await db.query('UPDATE students SET password = $1 WHERE roll_number = $2', [hashed, roll_number]);
  res.json({ reset: true });
});

// ============================================================
// Authenticated endpoints
// ============================================================

app.post('/api/requests', authenticate, requireRole('student'), async (req, res) => {
  const { pickup_place, dropoff_place } = req.body;
  if (!pickup_place || !dropoff_place) {
    return res.status(400).json({ error: 'pickup_place and dropoff_place are required' });
  }
  const p = coreLocationFromName(pickup_place);
  const d = coreLocationFromName(dropoff_place);
  if (!coreRouteIsValid(p, d)) {
    return res.status(400).json({ error: 'unknown pickup/dropoff or same-location route' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [maxRow] = await conn.query('SELECT COALESCE(MAX(request_number),0)+1 AS rn FROM pickup_requests');
    const rn = maxRow[0].rn;
    const dir = p < d ? 1 : -1;
    await conn.query(
      'INSERT INTO pickup_requests (request_number, student_roll_number, pickup_place, dropoff_place, '
      + 'pickup_location, dropoff_location, direction, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [rn, req.session.roll_number, pickup_place, dropoff_place, p, d, dir, 'PENDING_APPROVAL']);
    await conn.commit();
    res.status(201).json({ request_number: rn, status: 'PENDING_APPROVAL' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'could not create request' });
  } finally {
    conn.release();
  }
});

app.get('/api/requests/mine', authenticate, requireRole('student'), async (req, res) => {
  const [rows] = await db.query(
    'SELECT r.request_number, s.name AS student_name, s.roll_number AS student_roll_number, '
    + 's.hostel_name, s.room_number, s.phone_number, r.pickup_place, r.dropoff_place, r.status '
    + 'FROM pickup_requests r JOIN students s ON r.student_roll_number = s.roll_number '
    + 'WHERE r.student_roll_number = $1 ORDER BY r.request_number DESC', [req.session.roll_number]);

  // Batch-fill bus assignments
  const [assigns] = await db.query('SELECT request_number, bus_number FROM bus_assignments');
  const assignMap = {};
  assigns.forEach(a => assignMap[a.request_number] = a.bus_number);

  const result = rows.map(r => ({
    request_number: r.request_number,
    student_name: r.student_name,
    roll_number: r.student_roll_number,
    hostel: r.hostel_name,
    room: r.room_number,
    phone: r.phone_number,
    pickup: r.pickup_place,
    dropoff: r.dropoff_place,
    status: r.status,
    bus: assignMap[r.request_number] || 0,
  }));

  res.json({ count: result.length, requests: result });
});

app.get('/api/requests', authenticate, requireRole('guard', 'scheduler'), async (req, res) => {
  let query = 'SELECT r.request_number, s.name AS student_name, s.roll_number AS student_roll_number, '
    + 's.hostel_name, s.room_number, s.phone_number, r.pickup_place, r.dropoff_place, r.status '
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
  const [assigns] = await db.query('SELECT request_number, bus_number FROM bus_assignments');
  const assignMap = {};
  assigns.forEach(a => assignMap[a.request_number] = a.bus_number);

  const result = rows.map(r => ({
    request_number: r.request_number,
    student_name: r.student_name,
    roll_number: r.student_roll_number,
    hostel: r.hostel_name,
    room: r.room_number,
    phone: r.phone_number,
    pickup: r.pickup_place,
    dropoff: r.dropoff_place,
    status: r.status,
    bus: assignMap[r.request_number] || 0,
  }));

  res.json({ count: result.length, requests: result });
});

app.post('/api/requests/:id/approve', authenticate, requireRole('guard'), async (req, res) => {
  const id = parseInt(req.params.id);
  const ok = await coreApproveRequest(id);
  if (!ok) {
    const [rows] = await db.query('SELECT status FROM pickup_requests WHERE request_number = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'request not found' });
    return res.status(409).json({ error: 'request is not pending' });
  }
  res.json({ request_number: id, status: 'APPROVED' });
});

app.post('/api/requests/:id/reject', authenticate, requireRole('guard'), async (req, res) => {
  const id = parseInt(req.params.id);
  const ok = await coreRejectRequest(id);
  if (!ok) {
    const [rows] = await db.query('SELECT status FROM pickup_requests WHERE request_number = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'request not found' });
    return res.status(409).json({ error: 'request is not pending' });
  }
  res.json({ request_number: id, status: 'REJECTED' });
});

app.get('/api/buses', authenticate, requireRole('scheduler'), async (req, res) => {
  const [rows] = await db.query('SELECT * FROM buses ORDER BY bus_number');
  const result = rows.map(b => ({
    bus_number: b.bus_number,
    route: `${LOCATIONS[b.route_pickup]} -> ${LOCATIONS[b.route_dropoff]}`,
    route_pickup: b.route_pickup,
    route_dropoff: b.route_dropoff,
    assigned: b.current_count,
    capacity: b.max_capacity,
  }));
  res.json({ count: result.length, buses: result });
});

app.post('/api/buses', authenticate, requireRole('scheduler'), async (req, res) => {
  const { route_pickup, route_dropoff, max_capacity } = req.body;
  if (route_pickup == null || route_dropoff == null || max_capacity == null) {
    return res.status(400).json({ error: 'route_pickup, route_dropoff and max_capacity are required' });
  }
  if (!coreRouteIsValid(route_pickup, route_dropoff)) {
    return res.status(400).json({ error: 'invalid route (0=JUIT,1=Ravli PG,2=Peach Tree,3=Waknaghat)' });
  }
  if (max_capacity < 1 || max_capacity > MAX_BUS_CAPACITY) {
    return res.status(400).json({ error: 'max_capacity must be 1-30' });
  }
  const [maxRow] = await db.query('SELECT COALESCE(MAX(bus_number),0)+1 AS bn FROM buses');
  const bn = maxRow[0].bn;
  await db.query(
    'INSERT INTO buses (bus_number, route_pickup, route_dropoff, current_count, max_capacity) VALUES ($1,$2,$3,$4,$5)',
    [bn, route_pickup, route_dropoff, 0, max_capacity]);
  res.status(201).json({
    bus_number: bn, route_pickup, route_dropoff, max_capacity,
  });
});

app.post('/api/buses/assign', authenticate, requireRole('scheduler'), async (req, res) => {
  try {
    const result = await coreAssignApprovedRequests();
    res.json(result);
  } catch {
    res.status(500).json({ error: 'database error during assignment' });
  }
});

app.post('/api/assignments/unassign', authenticate, requireRole('scheduler'), async (req, res) => {
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
});

app.get('/api/reports/capacity', authenticate, requireRole('guard', 'scheduler'), async (req, res) => {
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
