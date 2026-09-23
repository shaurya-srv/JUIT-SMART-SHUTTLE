# JUIT Smart Shuttle — PRD Implementation Roadmap

> Tracks the **JUIT Smart Shuttle PRD** (baseline + planned Intelligent Dispatch
> Optimization) against this repository. PRD sections are referenced as §n.
> Last verified against the code: **2026-09-23** — migrations 001–009 present,
> `b427024` carries the user-verified `route_stops` coordinates + end-bounds
> join rule; **158 automated checks across 7 suites, all green**.

**Status legend:** ✅ implemented · 🟡 partial · ❌ not started · 🔶 exists but needs hardening before real students onboard

---

## 1. Scorecard

| Area | Status | Summary |
|---|---|---|
| Baseline roles & request lifecycle (§2–5) | ✅ | All four roles, full lifecycle with preconditions |
| Functional requirements FR-01–08, 12–15 (§7) | ✅ | Auth, requests, capacity guard, auto-assign, timetable, reports, staff passwords |
| FR-03 booking cutoff | ✅ | Built on top of baseline (optional `required_time`) |
| Dispatch optimizer (§6, FR-09–11) | ✅ v1 | Engine ships: pools by route+deadline, fills scheduled departures, van/bus sizing, decision log |
| Dynamic active-trip insertion (FR-16–17) | ✅ v1 | join-running-bus on live trips — end-bounds corridor rule, all four coordinates user-verified |
| Conductor mode & walk-ins (§4.5, §7.15–7.17, WR-01–07) | ✅ v1 | Conductor role, audited walk-ins/no-shows/check-ins (occupancy_events), manifest view — live after Phase 0 cutover |
| Live GPS tracking (§7.18–7.26) | ✅ v1 | Trips entity, conductor GPS share, public live board with 90 s staleness, join-running-bus — live after Phase 0 cutover |
| Non-functional requirements (§8) | ✅ | Core NFRs met; reset hardening + login rate limiting **done**; DB password rotation outstanding |

---

## 2. Functional Requirements (§7 table)

| ID | Requirement | Status | Evidence / Notes |
|---|---|---|---|
| FR-01 | Authenticate users by role | ✅ | `POST /api/login`, JWT 8 h, `requireRole` middleware; PBKDF2 hashes with per-row salt |
| FR-02 | Students create transport requests | ✅ | `POST /api/requests` (roll-scoped via session) |
| FR-03 | Enforce 30-min advance booking cutoff | ✅ | `parseRequiredTime()` in `server/lib/service.js` (pure, injectable clock); enforced in `POST /api/requests`; `required_time` column in migration 004. **Acceptance met:** past / inside-window / invalid each return distinct 400s; exact 30:00 boundary allowed |
| FR-04 | Maintain lifecycle status | ✅ | `PENDING_APPROVAL → APPROVED → COMPLETED` / `REJECTED`; preconditions in `service.js`; `completed_at` set on completion |
| FR-05 | Guard approves/rejects | ✅ | `POST /api/requests/:id/approve` / `reject` (guard-only) |
| FR-06 | Scheduler registers vehicles with route + capacity | ✅ | `POST /api/buses`; also accepts `vehicle_type` (bus/van, PRD §6.8) |
| FR-07 | Never assign beyond registered capacity | ✅ | Atomic capacity-guarded `UPDATE ... WHERE current_count < max_capacity`; same guard reused by walk-ins (WR-02) and joins (FR-16) |
| FR-08 | Automatic route-compatible assignment | ✅ | First-fit by lowest bus number on exact route; now restricted to `state = 'AVAILABLE'` (§7.13) |
| FR-09 | Optimizer combines requests into fewer trips | ✅ v1 | `planDispatch()` pools approved requests per (route, window); fills existing departures before needing new ones. Full trip-merging economics land with the Intelligence phase (7.2) |
| FR-10 | Prefer existing feasible trips | ✅ v1 | Scheduled timetable departures **are** the trips (one capacity per `(bus, departure_time)`); earliest feasible filled first |
| FR-11 | Select vehicle size by demand | ✅ v1 | Equal-departure tie-break prefers a right-sized van (3–6 seats) over a bus; per-departure capacity never exceeded |
| FR-12 | Timetable + live capacity to students | ✅ | `GET /api/timetable` (auth) + `GET /api/timetable/public` (no auth) + 60 s live refresh on the login-screen view (in-place repaint, generation guard, visibility catch-up) |
| FR-13 | Guard completes rides, frees seats | ✅ | `POST /api/requests/:id/complete`; seat decremented, assignment history kept |
| FR-14 | Scheduler monitors route capacity | ✅ | `GET /api/reports/capacity` (per-route assigned/capacity/available) |
| FR-15 | Admin manages staff passwords in-app | ✅ | `GET /api/admin/staff`, `POST /api/admin/staff-password` (min 8 chars, hashed) |
| — | **Beyond PRD:** admin-managed student accounts | ✅ | Public reset removed; bulk import (`POST /api/admin/students`), shared default password, forced first-login change (`must_change_password`, enforced in middleware), admin-only reset (`POST /api/admin/students/:roll/password`) |
| FR-16 | Add approved requests to active/dispatched trips when feasible | ✅ v1 | `POST /api/trips/:id/join` — student attaches an APPROVED request to a boarding/rolling trip; per-departure cap + FR-07 atomic seat claim |
| FR-17 | Reject unsafe dynamic insertion (capacity / detour / service window) | ✅ v1 | pure `validateJoin()`: not-approved / route+direction (corridor walk-distance + end-bounds) / window-passed / departure-full / no-live-tracking / stop-already-passed / bus-off-route — each a specific 409, never silent; unmapped coords fail SAFE |

---

## 3. Walk-In / Conductor Rules (§7.15–7.17)

| ID | Rule | Status | How it is met |
|---|---|---|---|
| WR-01 | Walk-in only on an active/eligible trip | ✅ | `POST /api/occupancy` 409s unless the vehicle is `DISPATCHED`/`ON_TRIP` |
| WR-02 | Capacity check before seat consumed | ✅ | Reuses the FR-07 guarded UPDATE in both directions + per-departure cap; can never go negative |
| WR-03 | Conductor/Guard authenticated + authorized | ✅ | `conductor` role in `credentials`; `requireRole('conductor','guard','admin')` on occupancy routes; no scheduler endpoints exposed (§7.26) |
| WR-04 | Seats remaining update immediately | ✅ | Live seat count reflects the walk-in on next read |
| WR-05 | Audit trail for manual adjustment | ✅ | `occupancy_events` table: who, when, trip, type (walk-in / no-show / check-in / adjustment), remark |
| WR-06 | Walk-ins visible in occupancy without a pickup request | ✅ | Trip manifest (`GET /api/occupancy/trip/:bus`) counts rows that have no `request_number` |
| WR-07 | No silent bypass of route/safety/capacity | ✅ | `validateOccupancyEvent()` returns specific errors, never silent (18-check suite) |

---

## 4. Planned Features — Section 6 (Dispatch Optimization)

| PRD | Feature | Status | Notes / Acceptance criteria |
|---|---|---|---|
| 6.1 | 30-min booking cutoff | ✅ | See FR-03 |
| 6.2 | Planning window | ✅ | The window (booking cutoff → required_time) drives dispatch: only departures within `[need − earliness, need + delay]` are eligible |
| 6.3 | Optimization objective & priorities | ✅ v1 | Order enforced: capacity/safety (hard) → student windows (hard) → earliest feasible departure → right-sized vehicle → fewest vehicles |
| 6.4 | Shared-trip grouping | ✅ v1 | Requests sharing a feasible departure naturally pool onto it (per-departure seat accounting) |
| 6.5 | Earliest-deadline constraint | ✅ v1 | Requests processed earliest-`required_time`-first; the constrained seat always goes to the tightest deadline (tested) |
| 6.6 | Existing-trip-first policy | ✅ v1 | Only scheduled departures are used in v1; nothing new is invented |
| 6.7 | On-route dynamic pickup/drop addition | ✅ v1 | join-running-bus: corridor-membership route rule (coordinate-driven via `route_stops` with **user-verified coordinates**, 800 m walking tolerance, end-bounds rule, direction-aware); capacity/window/position hard constraints all specific-rejection |
| 6.8 | Vehicle selection (van 3–6, bus >6) | ✅ v1 | `seatRank()`: right-sized van < bus < undersized at equal departure; scheduler picks windows per run |
| 6.9 | Maximum acceptable delay | ✅ v1 | `max_delay_minutes` (default 30) + `max_earliness_minutes` (default 60) enforced in the planner; scheduler-prompted each run |
| 6.10 | Trip cost/score comparison | 🟡 | Implicit (earliest-first keeps later runs free); formal cost scoring deferred to the Intelligence phase |
| 6.11 | Recommended dispatch flow | ✅ v1 | `POST /api/buses/assign` runs pooling → windowing → sizing → guarded writes → DISPATCHED transitions |

---

## 5. Planned Features — Section 7

| PRD | Feature | Status | Notes |
|---|---|---|---|
| 7.1 | Demand prediction / peak awareness | ❌ | Intelligence phase — start with historical counts by (day, time, route); no ML in v1 |
| 7.2 | Smart trip merging | ❌ | Intelligence phase — after pooling is proven in daily use |
| 7.3 | No-show handling | ✅ | Conductor releases the seat from the manifest; audit record; booking rejected |
| 7.4 | Student check-in / boarding confirmation | ✅ v1 | Conductor check-ins via `occupancy_events` + manifest |
| 7.5 | Real-time occupancy & seat state | 🟡 | Seats update on booking/completion/walk-ins/no-shows; remaining: checked-in vs reserved distinction in student-facing seat counts (minor) |
| 7.6 | ETA information | ❌ | Intelligence phase — fixed per-segment estimates first; GPS ETA later (`trip_positions` history is already being collected as fuel) |
| 7.7 | Route-insertion decision engine | ✅ v1 | `validateJoin()` — ordered hard constraints with named codes; geometries in pure `lib/geo.js` (44 checks) |
| 7.8 | Priority / emergency requests | ❌ | Intelligence phase — staff-only flag; relaxes cost rules, never capacity/safety |
| 7.9 | Trip efficiency dashboard | ❌ | Intelligence phase — trips run, occupancy, trips avoided, est. savings |
| 7.10 | Explainable dispatch decisions | ✅ v1 | Dispatch report renders a per-request decision log (vehicle, departure, reason) + per-departure fill counts |
| 7.11 | Fairness / anti-starvation | ❌ | Intelligence phase — max-wait threshold forces dispatch even when uneconomical |
| 7.12 | Route utilization & dead-trip detection | ❌ | Intelligence phase — flags low-occupancy departures & empty return legs |
| 7.13 | Vehicle operational state | ✅ v1 | Column + CHECK + auto-assign guard + `PATCH .../state` + UI; auto-assign sets `DISPATCHED`, trip lifecycle flips `ON_TRIP`/`AVAILABLE` |
| 7.14 | Maintenance tracking | 🟡 | `last_service`/`next_service` columns exist; no UI, no auto-exclusion by date |
| 7.15–7.17 | Walk-ins & manual seat adjustments | ✅ v1 | See WR table — full Conductor portal (pick trip → walk-in → manifest → no-show) |
| 7.18–7.26 | Live tracking, conductor GPS mode, join-running-bus | ✅ v1 | conductor 📡 share (15 s throttle, hidden-tab pause), public live board with 90 s staleness ("last seen X min ago", never extrapolated), join-running-bus (see FR-16/17); positions INSERT-only as future ETA history |

---

## 6. Non-Functional (§8) & Known Backlog (§11)

| Item | Status | Notes |
|---|---|---|
| Role-based access control | ✅ | Per-route `requireRole` |
| Parameterized queries | ✅ | Everywhere (keep it that way) |
| Atomic capacity protection | ✅ | Guarded UPDATE pattern |
| Clean API error handling | ✅ | `ah()` wrapper + central handler — every new async route must stay wrapped |
| Responsive browser UI | ✅ | Mobile-first vanilla SPA |
| Vercel deploy + health monitoring | ✅ | `GET /api/health`; git-push deploys |
| UI / API / business-rule separation | ✅ | Business rules in `server/lib/service.js` |
| Traceable scheduling decisions | ✅ | Dispatch report logs a per-request decision (vehicle, departure, reason) |
| **Password reset hardening** | ✅ | Public reset **removed**; admin-managed passwords: bulk import, default password, forced first-login change (`must_change_password`), admin-only reset |
| **Login rate limiting** | ✅ | DB-backed sliding window (global across serverless instances): 8 fails / 15 min per account, 30 / 15 min per IP; 429 + Retry-After; fail-open on limiter outage |
| **DB password rotation** | ❌ | Old credential appeared in chat; rotate in Supabase + Vercel |
| **Production hardening while DB in limbo** | ✅ | Timetable + request lists degrade gracefully when migration columns are missing (fallback queries, label-sniffed vans); live board degrades honestly (`degraded:true`) only when the trips table is absent |

---

## 7. Delivery Plan — four phases (restructured 2026-09-23)

The plan is now organized the way the product is used, not by build era:

**Phase 1 Basics** (students + guard) → **Phase 2 Auto booking** → **Phase 3 Dispatch & conductor** → **Phase 4 Bus tracking**, with **Phase 0 = go-live** gating everything and an **Intelligence** stretch list after that.

Mapping from the old plan: old Phase 0/0.5 → Phase 0 + Phase 1 · old Phase 1 (dispatch engine) → Phase 3 · old Phase 2 (conductor) → Phase 3 · old Phase 3 (trips/GPS) → Phase 4 · old Phase 4 (intelligence) → Intelligence.

> **The single active blocker for every phase below is Phase 0.** All code through Phase 4 is built, tested, and deployed — it is dormant until the database cutover happens.

### Phase 0 — Go live (user actions, ~10 minutes; gates Phases 1–4)
1. **Vercel cutover** — Settings → Environment Variables: `SHUTTLE_DB_USER` → `postgres.afydafeurljiqlnydywh`, `SHUTTLE_DB_PORT` → `6543`; then Redeploy. (The old project has been pasted 4× with perfect grids and zero production effect — it is not the DB Vercel talks to. The new project has every migration verified.)
2. **Correct `route_stops` on the new project** — 4-line UPDATE with the user-verified pins (JUIT `31.016747, 77.073142` · Ravli PG `31.015282, 77.085094` · Peach Tree `31.012071, 77.086437` · Waknaghat `31.008946, 77.090653`); re-running migrations never overwrites these.
3. **Change all four staff passwords** (`guard`, `scheduler`, `admin`, `conductor`) — the new project still has the bootstrap `admin` password; conductor especially.

**Acceptance:** health reports `db_user: postgres.afydafeurljiqlnydywh` · timetable jumps 1 → **24+ departures** incl. vans · live board returns `count:0` **without** `degraded:true` · login still clean 401/400.

### Phase 1 — Basics: students & guard — ✅ CODE DONE · live after Phase 0
**Goal:** a student can log in and request transport; a guard approves and completes rides; the admin owns all accounts and can reset anything.
- Shipped: FR-01–05, FR-13 · admin-managed student passwords (bulk import by roll+name, shared default password, forced first-login change, admin-only reset) · staff password management (FR-15) · login rate limiting + admin Login Security monitor.
- Remaining (execution, not code): import the real student batch, hand out the default password **in person** (never a broadcast group), watch one forced change happen, exercise one admin reset.
- **Acceptance:** one real student completes import → default login → forced change → request → guard approve → completion; one "forgotten" password reset by admin and re-secured by the student.

### Phase 2 — Auto bus booking — ✅ CODE DONE · live after Phase 0
**Goal:** approved requests land on scheduled departures automatically, within capacity, with the timetable visible to everyone.
- Shipped: FR-03 30-min cutoff · FR-07 atomic capacity guard · FR-08 route-compatible auto-assign · FR-12 timetable (authenticated + public login-screen view with 60 s live refresh and next-departure) · student "Your ride" card.
- Remaining: nothing blocking; weekly timetable seed values are data, not code.
- **Acceptance:** several students book the same departure → live seat counts drop everywhere; over-capacity booking is rejected; a request inside the 30-min cutoff is refused with a clear 400.

### Phase 3 — Bus dispatch & conductor — ✅ CODE DONE · live after Phase 0
**Goal:** the scheduler turns pooled approvals into right-sized vehicle runs, and the conductor runs each bus with audited occupancy.
- Shipped: FR-09–11 + §6.2–6.9/6.11 (`planDispatch`: pooling by route+deadline, planning windows, van-vs-bus sizing, guarded writes, DISPATCHED transitions, per-request decision log) · §7.13 vehicle states · conductor role + `occupancy_events` (WR-01–07: walk-ins, no-shows, check-ins, manifest).
- Remaining (minor): checked-in vs reserved seat display (7.5), maintenance auto-exclusion (7.14), formal cost scoring (6.10).
- **Acceptance:** approve a batch → scheduler runs Dispatch → report reads sensibly and My Requests shows "Your ride: Bus #X — the 7:45 AM run"; conductor walk-in and no-show both move seats and appear in the audit trail; 8 bad passwords lock an account visible in Login Security.

### Phase 4 — Bus tracking — ✅ CODE DONE · live after Phase 0 + the route_stops UPDATE
**Goal:** students see the bus move in real time; the conductor shares GPS; a student already outside can join a running bus.
- Shipped: migration 009 (`trips`, `trip_positions`, `route_stops` — all four coordinates **user-pinned on a map**) · pure lifecycle state machine + conductor Trip Status screen · conductor 📡 GPS share (15 s throttle, hidden-tab pause, auto-stop on completion) · public Live Buses board (30 s auto-refresh, 90 s staleness — never extrapolated; honest `degraded:true` only on un-migrated DB) · join-running-bus (`validateJoin` with corridor + end-bounds rule, 800 m walk tolerance, FR-07 claim) · live status on the "Your ride" card.
- Remaining to live: Phase 0 cutover + the 4-line `route_stops` UPDATE.
- **Acceptance:** conductor starts a trip and shares location → a student's board shows the bus fresh (<90 s) with seats left; a mid-corridor student joins the running bus; COMPLETED restores `AVAILABLE`, completes remaining bookings, and stops GPS.

### Intelligence — stretch after Phase 4 (PRD §6/§7 leftovers)
Demand history + simple prediction (7.1) · trip merging (7.2) · ETAs from the `trip_positions` history already being collected (7.6) · priority requests (7.8) · efficiency dashboard (7.9) · anti-starvation threshold (7.11) · utilization/dead-trip detection (7.12). Plus the standing security debt: **rotate `SHUTTLE_DB_PASS`** (it appeared in chat).

---

## 8. Engineering guardrails (do not regress)
- Every async Express route stays wrapped in `ah()` (Express 4 won't catch throws).
- `db.query` returns `[rows, rowCount]` — check `rowCount` on UPDATE/DELETE.
- `vercel.json` stays minimal (a deprecated key once broke git builds).
- Supabase access only via the **pooler** host/port 6543.
- Migrations are idempotent and applied via SQL Editor (DB credentials are Vercel-Sensitive — the CLI cannot pull them).

## 9. Verification status of shipped work
- `node --check` clean on all server files and the inline frontend script.
- **Automated test suites** (`node server/tests/*.test.js`) — **158 checks, all passing**: join-flow 44 · trips lifecycle 29 · dispatch planner 24 · rate limiter 18 · occupancy validator 18 · live route gates 11+14.
- Admin-managed passwords: 17 behavioral checks against the real app (route removal, role gates, import validation, must-change-password middleware gate).
- FR-03: 10 scenarios tested (boundary, past, invalid, skew margins).
- Timetable/live-refresh: 8 next-departure scenarios + 7 poller behaviors tested (initial paint, stale-fetch discard, failure/retry, mode toggle, timer teardown).
- **Deployed `707cbc0` + `b427024` (2026-09-23):** Phases 1–4 all live in production but **dormant** — verified graceful on the un-migrated DB (live board `degraded:true`, clean 401s on trip/join/position routes, health up). Everything switches on with the Phase 0 cutover; no redeploy needed beyond it.
