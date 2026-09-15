// Login rate limiting — brute-force protection for staff & student passwords.
//
// Why Postgres: Vercel serverless functions are ephemeral and per-instance;
// an in-memory counter would be per-lambda and reset on every cold start.
// Counters in the shared DB make the limit global and durable.
//
// Model — sliding window over failed attempts, tracked per identity:
//   account key  student:<roll> | staff:<role>   cap 8 fails / 15 min
//   network key  ip:<client ip>                  cap 30 fails / 15 min
// A login is blocked while EITHER identity is at its cap (a attacker spraying
// many roll numbers from one laptop hits the IP cap; targeting one account
// hits the account cap). Successful logins clear the account counter.
//
// NAT reality (campus!): hundreds of students share one public IP, so the IP
// cap must sit far above the account cap — it only trips for actual spray
// patterns, not for a busy hostel corridor.

const db = require('./db');

const WINDOW_MINUTES = 15;
const ACCOUNT_MAX_FAILS = 8;   // per roll number / staff role
const IP_MAX_FAILS = 30;       // per client IP (NAT-tolerant)

const ACCOUNT_KEY_RE = /^(student|staff):[A-Za-z0-9_-]{1,50}$/;

// ---- pure helpers (unit-tested) -------------------------------------------

// Best-effort client IP behind proxies (Vercel sets x-forwarded-for; the
// rightmost entry is the one Vercel appended, so leftmost-original is used).
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim().slice(0, 45);
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function identityKey(kind, id) {
  const raw = String(id || '').trim();
  return kind === 'ip' ? 'ip:' + raw.slice(0, 50) : kind + ':' + raw;
}

// Decide from raw counters whether `key` may attempt a login now.
//   row: { fail_count, window_start, blocked_until } | undefined
function decideAttempt(row, nowMs, maxFails, windowMinutes) {
  if (!row) return { allowed: true };
  const now = nowMs;
  if (row.blocked_until && new Date(row.blocked_until).getTime() > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((new Date(row.blocked_until).getTime() - now) / 1000),
    };
  }
  const windowStart = new Date(row.window_start).getTime();
  const windowMs = windowMinutes * 60 * 1000;
  const withinWindow = now - windowStart < windowMs;
  if (withinWindow && row.fail_count >= maxFails) {
    const retryAfterSec = Math.ceil((windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

// ---- DB-backed operations (best-effort: limiter failure never blocks login) --

function safe(fn) {
  return fn().catch(() => undefined);
}

// Throws RateLimitedError when the account or the IP is blocked.
// kind: 'student' | 'staff'; id: roll number or staff role.
async function checkLoginAllowed(kind, id, ip) {
  const accK = identityKey(kind, id);
  const ipK = identityKey('ip', ip);
  const [rows] = await db.query(
    'SELECT identity_key, fail_count, window_start, blocked_until '
    + 'FROM login_failures WHERE identity_key = ANY($1)', [[accK, ipK]]);
  const byKey = new Map(rows.map(r => [r.identity_key, r]));

  const acc = decideAttempt(byKey.get(accK), Date.now(), ACCOUNT_MAX_FAILS, WINDOW_MINUTES);
  if (!acc.allowed) {
    const e = new Error('Too many failed attempts for this account. Try again in '
      + humanWait(acc.retryAfterSec) + '.');
    e.status = 429;
    e.retryAfterSec = acc.retryAfterSec;
    throw e;
  }
  const net = decideAttempt(byKey.get(ipK), Date.now(), IP_MAX_FAILS, WINDOW_MINUTES);
  if (!net.allowed) {
    const e = new Error('Too many failed attempts from this network. Try again in '
      + humanWait(net.retryAfterSec) + '.');
    e.status = 429;
    e.retryAfterSec = net.retryAfterSec;
    throw e;
  }
}

// Record one failed attempt against both the account and the IP.
async function recordLoginFailure(kind, id, ip) {
  const accK = identityKey(kind, id);
  const ipK = identityKey('ip', ip);
  await safe(() => bumpCounter(accK, ACCOUNT_MAX_FAILS));
  await safe(() => bumpCounter(ipK, IP_MAX_FAILS));
}

// Successful login clears the account counter (the IP counter stays —
// clearing it per success would let spray cycles reset themselves).
async function clearLoginFailures(kind, id) {
  await safe(() => db.query('DELETE FROM login_failures WHERE identity_key = $1',
    [identityKey(kind, id)]));
}

// ---- internals --------------------------------------------------------------

// Upsert semantics via explicit read-modify-write: simple, race-tolerant
// (worst case a concurrent attempt double-counts one failure — acceptable
// for a limiter) and portable across every Postgres version.
async function bumpCounter(key, maxFails) {
  const [existing] = await db.query(
    'SELECT fail_count, window_start FROM login_failures WHERE identity_key = $1', [key]);
  const now = Date.now();
  const windowMs = WINDOW_MINUTES * 60 * 1000;
  const inWindow = existing.length
    && (now - new Date(existing[0].window_start).getTime()) < windowMs;
  const failCount = inWindow ? existing[0].fail_count + 1 : 1;
  const windowStart = inWindow ? existing[0].window_start : new Date(now);
  // At the cap, hold the block until the window slides shut.
  const blockedUntil = failCount >= maxFails
    ? new Date(new Date(windowStart).getTime() + windowMs)
    : null;
  await db.query(
    'INSERT INTO login_failures (identity_key, fail_count, window_start, blocked_until) '
    + 'VALUES ($1, $2, $3, $4) '
    + 'ON CONFLICT (identity_key) DO UPDATE SET fail_count = $2, window_start = $3, blocked_until = $4',
    [key, failCount, windowStart, blockedUntil]);
}

function humanWait(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 'a moment';
  if (sec < 90) return Math.ceil(sec) + 's';
  return Math.ceil(sec / 60) + ' min';
}

// Validate an account key before it ever reaches the limiter layer.
function isSafeAccountKey(kind, id) {
  return ACCOUNT_KEY_RE.test(identityKey(kind, id));
}

module.exports = {
  clientIp, identityKey, decideAttempt, isSafeAccountKey,
  checkLoginAllowed, recordLoginFailure, clearLoginFailures,
  WINDOW_MINUTES, ACCOUNT_MAX_FAILS, IP_MAX_FAILS,
};
