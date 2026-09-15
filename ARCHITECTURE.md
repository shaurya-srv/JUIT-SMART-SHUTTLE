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
| `bus_assignments` | request → bus mapping (one per request), keeps history after completion |
| `bus_schedules` | per-bus departure times (`TIME`), optional label, FK to buses |

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

## 6. Known gaps / backlog
- ~~`POST /api/reset-password` is unauthenticated~~ — **removed.** Student
  passwords are admin-managed: bulk import with a default password, forced
  one-time change at first login (`students.must_change_password`, enforced in
  login and on every student request via the `mcp` token claim), logged-in
  change via `PUT /api/students/password`, and admin-only reset via
  `POST /api/admin/students/:roll/password` (also re-forces the change).
- No login rate limiting (brute-force protection for staff passwords).
- `SHUTTLE_DB_PASS` rotation pending (old password appeared in chat).

## 7. Legacy system (archived)
The project began as a C application: CLI portals (`legacy/src/cli`),
a business-rule core (`legacy/src/core`), a MySQL data layer, and a winsock2
HTTP/JSON server (`legacy/src/api`) with its own test suite
(`legacy/tests`). It was ported to Node.js/Express + PostgreSQL for Vercel;
the C tree is kept in `legacy/` for reference only.
