// Tests for the login rate limiter's pure decision core (no DB needed).
// Run: node server/tests/ratelimit.test.js
const {
  clientIp, identityKey, decideAttempt, isSafeAccountKey,
  ACCOUNT_MAX_FAILS, IP_MAX_FAILS, WINDOW_MINUTES,
} = require('../lib/ratelimit');

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + '  -> ' + JSON.stringify(extra)); }
}

const T0 = Date.parse('2026-09-15T10:00:00Z');
const MIN = 60 * 1000;
const row = (failCount, windowStartMs, blockedUntilMs) => ({
  fail_count: failCount,
  window_start: new Date(windowStartMs),
  blocked_until: blockedUntilMs ? new Date(blockedUntilMs) : null,
});

// ---- clientIp ---------------------------------------------------------
const fakeReq = (headers, remote) => ({
  headers,
  socket: { remoteAddress: remote || '10.0.0.1' },
});
check('1a. x-forwarded-for leftmost entry used',
  clientIp(fakeReq({ 'x-forwarded-for': '203.0.113.7, 10.1.2.3' })) === '203.0.113.7',
  clientIp(fakeReq({ 'x-forwarded-for': '203.0.113.7, 10.1.2.3' })));
check('1b. falls back to socket address',
  clientIp(fakeReq({})) === '10.0.0.1');
check('1c. unknown when nothing present',
  clientIp({ headers: undefined, socket: {} }) === 'unknown'
  && clientIp({ headers: {}, socket: null }) === 'unknown');

// ---- identityKey ------------------------------------------------------
check('2a. student key format',
  identityKey('student', '261030195') === 'student:261030195');
check('2b. staff key format',
  identityKey('staff', 'admin') === 'staff:admin');
check('2c. ip key format + truncation',
  identityKey('ip', 'x'.repeat(80)).length <= 53, identityKey('ip', 'x'.repeat(80)).length);
check('2d. null/undefined id handled',
  identityKey('student', null) === 'student:', identityKey('student', null));

// ---- decideAttempt ----------------------------------------------------
check('3a. no row -> allowed',
  decideAttempt(undefined, T0, 8, 15).allowed === true);
check('3b. under cap within window -> allowed',
  decideAttempt(row(7, T0 - 5 * MIN), T0, ACCOUNT_MAX_FAILS, WINDOW_MINUTES).allowed === true);
check('3c. at cap within window -> blocked, retry = window remainder',
  decideAttempt(row(8, T0 - 5 * MIN), T0, ACCOUNT_MAX_FAILS, WINDOW_MINUTES).retryAfterSec === 10 * 60);
check('3d. same count after window slid -> allowed again',
  decideAttempt(row(8, T0 - 16 * MIN), T0, ACCOUNT_MAX_FAILS, WINDOW_MINUTES).allowed === true);
check('3e. active blocked_until wins even under window cap',
  decideAttempt(row(3, T0 - 1 * MIN, T0 + 4 * MIN), T0, ACCOUNT_MAX_FAILS, WINDOW_MINUTES).allowed === false);
check('3f. expired blocked_until -> falls through to window logic',
  decideAttempt(row(3, T0 - 20 * MIN, T0 - 1 * MIN), T0, ACCOUNT_MAX_FAILS, WINDOW_MINUTES).allowed === true);
check('3g. IP cap independent of account cap',
  decideAttempt(row(29, T0 - 2 * MIN), T0, IP_MAX_FAILS, WINDOW_MINUTES).allowed === true
  && decideAttempt(row(30, T0 - 2 * MIN), T0, IP_MAX_FAILS, WINDOW_MINUTES).allowed === false);

// ---- isSafeAccountKey -------------------------------------------------
check('4a. plain roll number safe',
  isSafeAccountKey('student', '261030195') === true);
check('4b. injection attempt rejected',
  isSafeAccountKey('student', "x'; DROP TABLE students; --") === false);
check('4c. staff role safe',
  isSafeAccountKey('staff', 'admin') === true);

// ---- threshold sanity -------------------------------------------------
check('5. account cap strictly below IP cap (NAT tolerance)',
  ACCOUNT_MAX_FAILS < IP_MAX_FAILS);

console.log(failures ? `\n${failures} FAILURE(S), ${passed} passed` : `\nALL ${passed} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
