# JUIT Smart Shuttle — Features & Architecture

> Current as of **2026-09-13**. This describes the live production system:
> a vanilla-JS single-page frontend on Vercel, an Express serverless API, and
> PostgreSQL on Supabase. The original C/MySQL implementation is archived
> under `legacy/`.

## 1. Features (what the app does today)

### Roles
Four roles log in through the same screen: **Student**, **Guard**,
**Bus Scheduler**, **Admin**. All portals are browser-based; there is no CLI
in production anymore.

### Student portal
- Register (roll number, name, room, hostel, phone, password)
- Create pickup requests between the four locations
  (JUIT, Ravli PG, Peach Tree, Waknaghat), optionally with a **required
  transport time** — must be booked ≥ 30 min ahead (PRD FR-03, planning
  window for the dispatch optimizer)
- Track own requests with live status and assigned bus number
- View the **bus timetable**: departure times, bus numbers, routes,
  and seats remaining per departure
- No account? The login screen links a **public timetable** (today / full
  week toggle + next departure) served by the unauthenticated
  `GET /api/timetable/public` (read-only, exposes no student data)

### Guard portal
- Dashboard with live pending-request count
- Approve or reject pending requests
- Browse approved / rejected / completed lists
- **Complete rides**: an approved ride moves to `COMPLETED` and its bus seat
  is freed
- View the timetable

### Scheduler portal
- Register buses/vans with route (pickup → dropoff), capacity (1–30) and
  vehicle type (bus/van)
- **Vehicle state management** (AVAILABLE / DISPATCHED / ON_TRIP /
  MAINTENANCE / OFFLINE) — set from the Bus Schedule view
- **Auto-assign**: batch-assign approved requests to the first matching-route
  AVAILABLE vehicle with free seats (atomic capacity guard; 80%-full warning
  report; MAINTENANCE/OFFLINE/DISPATCHED/ON_TRIP vehicles are skipped)
- Bus schedule view with per-bus live seat bars
- Route capacity report (seats assigned vs capacity per route)
- **Timetable editor**: add/remove scheduled departures per bus
  (time picker, optional label, duplicate + validation guards)

### Admin portal
- Everything the scheduler can do (buses, auto-assign, timetable, reports)
- **Staff account management**: see every role's password state
  (hashed / plaintext) and change any staff password in-app
  (min 8 chars, stored as PBKDF2 hash)

### Request lifecycle
```
PENDING_APPROVAL ──guard──► APPROVED ──guard──► COMPLETED (seat freed)
        │
        └──guard──► REJECTED (terminal)
```

## 2. Production architecture

```
┌─────────────────────────────────────────────────────────┐
│ Browser — index.html (vanilla JS SPA, no build step)    │
│  apiCall() fetch wrapper · JWT in localStorage          │
└───────────────┬─────────────────────────────────────────┘
                │ HTTPS (same origin, /api/*)
┌───────────────▼─────────────────────────────────────────┐
│ Vercel                                                  │
│  • static: index.html at /                              │
│  • serverless function: api/index.js                    │
│    (boots server/server.js Express app; rewrites route  │
│     /api/* to it via vercel.json)                       │
└───────────────┬─────────────────────────────────────────┘
                │ TLS, IPv4
┌───────────────▼─────────────────────────────────────────┐
│ Supabase PostgreSQL (region ap-northeast-1)             │
│  reached through the connection POOLER (PgBouncer,      │
│  port 6543) — the direct host is IPv6-only and would    │
│  hang from Vercel                                       │
└─────────────────────────────────────────────────────────┘
```

### Backend (Express, 21 routes)
- **Auth**: JWT bearer tokens, 8-hour expiry, signed with `JWT_SECRET`
- **Passwords**: PBKDF2-HMAC-SHA256, 60,000 iterations, per-row random salt
  (`pbkdf2-sha256$iter$salt$hash`); legacy plaintext rows auto-upgrade on login
- **Authorization**: `authenticate` + `requireRole(...)` middleware per route
- **Safety**: parameterized queries only, 4 KB JSON body limit, every async
  route wrapped (`ah()`) so a DB error returns a clean 500 instead of killing
  the serverless function
- **Login rate limiting** (`server/lib/ratelimit.js`, migration 007): failed
  logins counted in the `login_failures` table — 8 per account / 15 min,
  30 per source IP / 15 min (NAT-tolerant for campus WiFi). Blocked attempts
  get HTTP 429 + `Retry-After`. Counters live in Postgres because serverless
  instances are ephemeral; the limiter fails open if the DB hiccups (an
  outage must never lock the campus out). Successful logins clear the
  account counter; the IP counter only ages out with its window.
- **DB access**: `server/lib/db.js` wraps `pg` to return `[rows, rowCount]`
  (update/insert code must read `rowCount` — the approve/reject/assign
  bug class we fixed)

### Business rules (`server/lib/service.js`)
Pure orchestration, no HTTP concerns — mirrors the legacy `core/service.c`:
- Lifecycle transitions with state preconditions
- Assignment algorithm: within one transaction, for each APPROVED request
  (ordered), first-fit the lowest-numbered bus on the exact route with
  `current_count < max_capacity`; increment with a capacity-guarded UPDATE,
  insert the assignment row, warn at ≥80% capacity

## 3. Repository layout

```
index.html                 entire frontend (SPA, embedded CSS/JS, no tooling)
api/index.js               serverless entry: exports the Express app to Vercel
server/
  server.js                all routes + auth middleware + error handler
  lib/db.js                pg pool wrapper → [rows, rowCount]; SSL off locally,
                           TLS enforced for any non-localhost host
  lib/service.js           lifecycle transitions + assignment algorithm
  lib/crypto.js            PBKDF2 hashing + CSPRNG
  lib/models.js            location constants, route validation, capacity caps
  check-db.js              standalone DB connectivity checker
  supabase-schema.sql      base schema (5 tables + credential seeds)
  migrations/001_...sql    bus_schedules table + completed_at column
  migrations/002_...sql    fixed Mon-Sat timetable seed (07:45/08:15, 16:55/17:30)
  migrations/003_...sql    Sunday van seed (09:00/10:30, 16:55/17:30, 12-seat vans)
  migrations/004_...sql    dispatch foundation: required_time, vehicle_type, state
vercel.json                rewrites only ("/api/*" → function)
.vercelignore              keeps legacy/, installers, local junk out of uploads
legacy/                    archived C CLI + winsock2 HTTP server + MySQL code
```

## 4. Data model (Supabase `public` schema)

| Table | Purpose |
|---|---|
| `students` | roll number (PK), name, room, hostel, phone, PBKDF2 password |
| `credentials` | one row per staff role (`guard`, `scheduler`, `admin`), PBKDF2 password |
| `pickup_requests` | request number, student FK, named places, location indexes, direction, status, `required_time` (PRD 6.1), `completed_at` |
| `buses` | bus number, route pickup/dropoff (location indexes), `current_count`, `max_capacity`, `vehicle_type` (bus/van), `state` (AVAILABLE/DISPATCHED/ON_TRIP/MAINTENANCE/OFFLINE), `last_service`/`next_service` |
| `bus_assignments` | request → bus mapping (one per request), keeps history after completion; `departure_time` (migration 006) scopes the booking to a specific run |
| `bus_schedules` | per-bus departure times (`TIME`), optional label, FK to buses |
| `trips` | (Phase 3) lazy lifecycle rows keyed by the same `(bus_number, departure_time)` identity — `UNIQUE`; states `SCHEDULED→BOARDING→DEPARTED→EN_ROUTE→COMPLETED`/`CANCELLED`, actual departure/arrival stamps |
| `trip_positions` | (Phase 3) INSERT-only GPS fixes per trip — route history for Phase 4 ETAs |
| `occupancy_events` | (Phase 2) audited walk-ins/no-shows/check-ins keyed by `(bus_number, departure_time)` |
| `login_failures` | (Phase 2) DB-backed brute-force counters (serverless-safe, global) |

Status values: `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `COMPLETED`.

## 5. Deployment & operations

- **Deploy = `git push`** to `main` (Vercel git integration builds ~10 s).
  Fallback: `npx vercel --prod` from the project root.
- **Env vars** (Vercel → Production): `SHUTTLE_DB_HOST` (pooler host
  `aws-0-<region>.pooler.supabase.com`), `SHUTTLE_DB_PORT=6543`,
  `SHUTTLE_DB_NAME=postgres`, `SHUTTLE_DB_USER=postgres.<project-ref>`,
  `SHUTTLE_DB_PASS`, `JWT_SECRET` (long random hex).
- **Health check**: `GET /api/health` → `{"status":"ok","database":"up|down"}`.
- **Cold starts**: after ~15 idle minutes Vercel recycles the function; the
  first request pays boot + fresh DB connection (a few seconds). The frontend
  allows 25 s before aborting.
- **Migrations**: apply SQL from `server/migrations/` in the Supabase SQL
  Editor (they are written idempotent).

### Hard-won gotchas (do not regress)
1. `vercel.json` must stay minimal — a deprecated key (`"public"`) fails
   git-build schema validation while CLI builds tolerate it.
2. `.vercelignore` must keep large local files (e.g. installers) out of
   uploads — an 83 MB installer once stalled deploys for a day.
3. The Supabase user on the pooler is `postgres.<ref>`, not `postgres`.
4. Express 4 does not catch async throws — every route stays wrapped in `ah()`.

## 6. Dispatch engine (v1)
`server/lib/service.js` splits the optimizer into a **pure planner** and a
**transactional applier**:
- `planDispatch(requests, vehicles, schedules, tripLoads, now, options)` —
  pools APPROVED requests earliest-`required_time`-first, matches each against
  scheduled departures (each `(bus, departure_time)` is an independently
  capped trip), enforces the `max_delay_minutes` (30) / `max_earliness_minutes`
  (60) windows, prefers right-sized vans at equal departures, and returns a
  per-request decision log. Fully unit-tested (`server/tests/dispatch.test.js`, 24 checks).
- `coreDispatchApprovedRequests(options)` — loads live data, plans, writes
  assignments with the FR-07 guarded UPDATE, records `departure_time` per
  assignment, and flips used vehicles to `DISPATCHED`. Re-runnable: prior
  per-departure loads are honored.
- `POST /api/buses/assign` accepts `{ max_delay_minutes, max_earliness_minutes }`.
- Campus time: JUIT is IST (UTC+05:30) while Vercel runs UTC — naive
  `datetime-local` values are parsed as IST wall-clock (`parseCampusLocal`),
  and timetable `HH:MM` strings convert via `campusTimeToDate`.

## 7. Conductor mode (Phase 2)
A fifth staff role, `conductor` (migration 008 seeds it — change the bootstrap
password), records on-vehicle reality against a **dispatched** departure:
- `POST /api/occupancy` (guard/conductor/admin) — `WALK_IN` (+1 seat),
  `NO_SHOW` (−1 seat, rejects the booking and frees the assignment),
  `CHECK_IN`, `ADJUSTMENT` (explicit delta). Every event lands in
  `occupancy_events` with actor + remark (WR-05).
- WR-01: only vehicles in `DISPATCHED`/`ON_TRIP` accept events.
- WR-02: seats move through the FR-07 guarded UPDATE both directions and
  respect the per-departure cap, never below zero.
- `GET /api/occupancy/trip/:bus_number?departure_time=...` — manifest of
  booked students + recent events, for the conductor's tablet.
- Pure validator (`validateOccupancyEvent`) is unit-tested in
  `server/tests/occupancy.test.js` (18 checks).

## 8. Trip lifecycle, GPS & join-running-bus (Phase 3)
`trips` rows are created **lazily** when a conductor/guard/admin starts a run —
a departure nobody tracks never gets a row, and every Phase 1/2 flow works
with zero trips rows (same fail-soft rule as the 004/006 hardening). The row
adopts the identity occupancy_events and assignments already use:
`(bus_number, departure_time)` with a UNIQUE constraint (migration 009).
- `POST /api/trips/start` (conductor/guard/admin) — create-or-attach today's
  run; idempotent via ON CONFLICT (re-starting returns the same row).
- `POST /api/trips/:id/state` (conductor/guard/admin) — validated by the pure
  `canTransition()` state machine; `DEPARTED` flips the bus `ON_TRIP` (PRD
  7.13's auto half); `COMPLETED`/`CANCELLED` set it back to `AVAILABLE`, reset
  occupancy, and `COMPLETED` also completes remaining APPROVED bookings on
  that departure.
- `GET /api/trips/current` — read a run's lifecycle state (also schedulers).
- Conductor portal: **Trip Status** screen drives Start → Boarding → Depart →
  En-Route → Arrive with a Cancel fallback, plus the 📡 **Share live location**
  toggle (browser geolocation, 15 s client throttle, pauses on hidden tab,
  stops on completion/cancel).
- `POST /api/trips/:id/position` (conductor/guard/admin) — GPS ingest:
  plausibility check, 5 s server-side dedupe backstop, 7-day opportunistic
  prune (positions double as Phase 4 ETA history).
- `GET /api/trips/active` (public) — the live board: active trips + latest
  fix + age. 90 s staleness: students see "last seen X min ago", never an
  extrapolated position. Degrades to an empty board **only** when the trips
  table is missing (un-migrated DB); a genuine DB outage surfaces as an error
  (never a fake "no buses running") — `isMissingTableError()` draws that line.
- `POST /api/trips/:id/join` (student, own request) — join-running-bus
  (FR-16/17): pure `validateJoin()` checks status → route+direction
  (corridor membership via `route_stops` coordinates, 500 m walk tolerance,
  never index-assumed) → service window (≤30 min past) → per-departure
  capacity → (moving bus) fresh fix, on-corridor, stop not passed — every
  rejection a specific 409 code; the seat moves through the FR-07 guarded
  UPDATE in the same transaction as the assignment insert. Unmapped
  coordinates fail SAFE.
- Geometry lives in `server/lib/geo.js` (pure): haversine, corridor
  projection, stop-passed, staleness, dedupe, plausibility.
- Design: `TRIPS_GPS_DESIGN.md`. **The seeded `route_stops` coordinates are
  approximate — ground-truth them and UPDATE; every join decision derives
  from them.**

## 9. Known gaps / backlog
- ~~`POST /api/reset-password` is unauthenticated~~ — **removed.** Student
  passwords are admin-managed: bulk import with a default password, forced
  one-time change at first login (`students.must_change_password`, enforced in
  login and on every student request via the `mcp` token claim), logged-in
  change via `PUT /api/students/password`, and admin-only reset via
  `POST /api/admin/students/:roll/password` (also re-forces the change).
- ~~No login rate limiting~~ — **done**: DB-backed sliding window (8 fails/
  15 min per account, 30/15 min per IP), 429 + Retry-After, admin monitor.
- `SHUTTLE_DB_PASS` rotation pending (old password appeared in chat).

## 10. Legacy system (archived)
The project began as a C application: CLI portals (`legacy/src/cli`),
a business-rule core (`legacy/src/core`), a MySQL data layer, and a winsock2
HTTP/JSON server (`legacy/src/api`) with its own test suite
(`legacy/tests`). It was ported to Node.js/Express + PostgreSQL for Vercel;
the C tree is kept in `legacy/` for reference only.
