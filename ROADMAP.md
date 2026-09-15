# JUIT Smart Shuttle — PRD Implementation Roadmap

> Tracks the **JUIT Smart Shuttle PRD** (baseline + planned Intelligent Dispatch
> Optimization) against this repository. PRD sections are referenced as §n.
> Last verified against the code: **2026-09-15** — 26 Express routes,
> migrations 001–007 present (plus the combined `apply_all_pending.sql`).

**Status legend:** ✅ implemented · 🟡 partial · ❌ not started · 🔶 exists but needs hardening before real students onboard

---

## 1. Scorecard

| Area | Status | Summary |
|---|---|---|
| Baseline roles & request lifecycle (§2–5) | ✅ | All four roles, full lifecycle with preconditions |
| Functional requirements FR-01–08, 12–15 (§7) | ✅ | Auth, requests, capacity guard, auto-assign, timetable, reports, staff passwords |
| FR-03 booking cutoff | ✅ | Built on top of baseline (optional `required_time`) |
| Dispatch optimizer (§6, FR-09–11) | ✅ v1 | Engine ships: pools by route+deadline, fills scheduled departures, van/bus sizing, decision log |
| Dynamic active-trip insertion (FR-16–17) | ❌ | Needs the trips entity |
| Conductor mode & walk-ins (§4.5, §7.15–7.17, WR-01–07) | ✅ v1 | Conductor role, audited walk-ins/no-shows/check-ins (occupancy_events), manifest view — needs migration 008 |
| Live GPS tracking (§7.18–7.26) | ❌ | Highest-risk PRD area (their own backlog flags it) |
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
| FR-07 | Never assign beyond registered capacity | ✅ | Atomic capacity-guarded `UPDATE ... WHERE current_count < max_capacity`; same guard to be reused by walk-ins (WR-02) |
| FR-08 | Automatic route-compatible assignment | ✅ | First-fit by lowest bus number on exact route; now restricted to `state = 'AVAILABLE'` (§7.13) |
| FR-09 | Optimizer combines requests into fewer trips | ✅ v1 | `planDispatch()` pools approved requests per (route, window); fills existing departures before needing new ones. Full trip-merging economics land with Phase 4 (7.2) |
| FR-10 | Prefer existing feasible trips | ✅ v1 | Scheduled timetable departures **are** the trips (one capacity per `(bus, departure_time)`); earliest feasible filled first |
| FR-11 | Select vehicle size by demand | ✅ v1 | Equal-departure tie-break prefers a right-sized van (3–6 seats) over a bus; per-departure capacity never exceeded |
| FR-12 | Timetable + live capacity to students | ✅ | `GET /api/timetable` (auth) + `GET /api/timetable/public` (no auth) + 60 s live refresh on the login-screen view (in-place repaint, generation guard, visibility catch-up) |
| FR-13 | Guard completes rides, frees seats | ✅ | `POST /api/requests/:id/complete`; seat decremented, assignment history kept |
| FR-14 | Scheduler monitors route capacity | ✅ | `GET /api/reports/capacity` (per-route assigned/capacity/available) |
| FR-15 | Admin manages staff passwords in-app | ✅ | `GET /api/admin/staff`, `POST /api/admin/staff-password` (min 8 chars, hashed) |
| — | **Beyond PRD:** admin-managed student accounts | ✅ | Public reset removed; bulk import (`POST /api/admin/students`), shared default password, forced first-login change (`must_change_password`, enforced in middleware), admin-only reset (`POST /api/admin/students/:roll/password`) |
| FR-16 | Add approved requests to active/dispatched trips when feasible | ✅ v1 | `POST /api/trips/:id/join` — student attaches an APPROVED request to a boarding/rolling trip; per-departure cap + FR-07 atomic seat claim |
| FR-17 | Reject unsafe dynamic insertion (capacity / detour / service window) | ✅ v1 | pure `validateJoin()`: not-approved / route+direction (corridor walk-distance) / window-passed / departure-full / no-live-tracking / stop-already-passed / bus-off-route — each a specific 409, never silent; unmapped coords fail SAFE |

---

## 3. Walk-In / Conductor Rules (§7.15–7.17)

| ID | Rule | Status | Acceptance criteria (when built) |
|---|---|---|---|
| WR-01 | Walk-in only on an active/eligible trip | ❌ | Endpoint 409s unless the vehicle is `DISPATCHED`/`ON_TRIP` |
| WR-02 | Capacity check before seat consumed | ❌ | Reuses the FR-07 guarded UPDATE; can never go negative |
| WR-03 | Conductor/Guard authenticated + authorized | ❌ | New `conductor` role in `credentials`; `requireRole('conductor','guard')` on walk-in routes; no scheduler endpoints exposed (§7.26) |
| WR-04 | Seats remaining update immediately | ❌ | Live seat count reflects the walk-in on next read |
| WR-05 | Audit trail for manual adjustment | ❌ | `occupancy_events` table: who, when, trip, type (walk-in / no-show / adjustment), remark |
| WR-06 | Walk-ins visible in occupancy without a pickup request | ❌ | Trip occupancy counts rows that have no `request_number` |
| WR-07 | No silent bypass of route/safety/capacity | ❌ | Walk-in constrained to the vehicle's current route/direction |

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
| 6.7 | On-route dynamic pickup/drop addition | ✅ v1 | join-running-bus: corridor-membership route rule (coordinate-driven via `route_stops`, walking-distance tolerance, direction-aware); capacity/window/position hard constraints all specific-rejection |
| 6.8 | Vehicle selection (van 3–6, bus >6) | ✅ v1 | `seatRank()`: right-sized van < bus < undersized at equal departure; scheduler picks windows per run |
| 6.9 | Maximum acceptable delay | ✅ v1 | `max_delay_minutes` (default 30) + `max_earliness_minutes` (default 60) enforced in the planner; scheduler-prompted each run |
| 6.10 | Trip cost/score comparison | 🟡 | Implicit (earliest-first keeps later runs free); formal cost scoring deferred to Phase 4 |
| 6.11 | Recommended dispatch flow | ✅ v1 | `POST /api/buses/assign` runs pooling → windowing → sizing → guarded writes → DISPATCHED transitions; active-trip steps land in Phase 3 |

---

## 5. Planned Features — Section 7

| PRD | Feature | Status | Notes |
|---|---|---|---|
| 7.1 | Demand prediction / peak awareness | ❌ | Start with historical counts by (day, time, route) — no ML in v1 |
| 7.2 | Smart trip merging | ❌ | After Phase 1's grouping is proven |
| 7.3 | No-show handling | ❌ | Phase 2 — releases seat, audit record, feeds utilization history |
| 7.4 | Student check-in / boarding confirmation | ❌ | Phase 2 — checked-in vs reserved distinction |
| 7.5 | Real-time occupancy & seat state | 🟡 | Seats update on booking/completion; no checked-in state, no walk-ins yet |
| 7.6 | ETA information | ❌ | Phase 4 — fixed per-segment estimates first; GPS ETA later |
| 7.7 | Route-insertion decision engine | ✅ v1 | `validateJoin()` — ordered hard constraints with named codes; geometries in pure `lib/geo.js` (39+ checks) |
| 7.8 | Priority / emergency requests | ❌ | Staff-only flag; relaxes cost rules, never capacity/safety |
| 7.9 | Trip efficiency dashboard | ❌ | Phase 4 — trips run, occupancy, trips avoided, est. savings |
| 7.10 | Explainable dispatch decisions | ✅ v1 | Dispatch report renders a per-request decision log (vehicle, departure, reason) + per-departure fill counts |
| 7.11 | Fairness / anti-starvation | ❌ | Max-wait threshold forces dispatch even when uneconomical |
| 7.12 | Route utilization & dead-trip detection | ❌ | Phase 4 — flags low-occupancy departures & empty return legs |
| 7.13 | Vehicle operational state | ✅ v1 | Column + CHECK + auto-assign guard + `PATCH .../state` + UI; dispatch now auto-sets `DISPATCHED` on used vehicles (`ON_TRIP` arrives with Phase 3 GPS) |
| 7.14 | Maintenance tracking | 🟡 | `last_service`/`next_service` columns exist; no UI, no auto-exclusion by date |
| 7.15–7.17 | Walk-ins & manual seat adjustments | ❌ | Phase 2 (see WR table) |
| 7.18–7.26 | Live tracking, conductor GPS mode, join-running-bus | ✅ v1 | conductor 📡 share (15 s throttle, hidden-tab pause), public live board with 90 s staleness ("last seen X min ago", never extrapolated), join-running-bus (see FR-16/17); positions INSERT-only as Phase 4 ETA history |

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
| **Production hardening while DB in limbo** | ✅ | Timetable + request lists degrade gracefully when 004/006 columns are missing (fallback queries, label-sniffed vans) |

---

## 7. Recommended Build Order

### Phase 0 — Ship what exists (now)
1. **TWO-DATABASE MYSTERY — THE ACTIVE BLOCKER.** Production (Vercel, pooler user `postgres`) hits a DB that still lacks the migration columns (fresh `column b.vehicle_type does not exist` errors on 2026-09-15), yet `apply_all_pending.sql` has been "run successfully" twice — both times apparently landing on the new project (`afydafeurljiqlnydywh`), whose fresh-project grid matches the expected numbers exactly and proves nothing. **Next step:** run `select count(*) from students;` in EACH project's SQL Editor — the one with real student rows is production. Run the SQL THERE.
2. Apply migrations **002–007** on that project via `server/migrations/apply_all_pending.sql` (idempotent; expected grid `12·6·24·12·12·1·1·1·1`). Fallback if the SQL Editor route keeps misfiring: Supabase access token + Management API over HTTPS (port 443 is reachable; 5432/6543 are firewalled on campus WiFi).
3. Security quick wins before students arrive: ~~protect reset-password~~ (done), ~~login rate limiting~~ (done), rotate `SHUTTLE_DB_PASS`.
4. ~~Commit & push engine + limiter~~ — shipped in `998bb8d`, deployed, and verified graceful on the un-migrated DB (limiter fails open → clean 401s; only request lists 500 until column 006 exists).

### Phase 1 — ~~Dispatch engine v1~~ ✅ DONE (2026-09-15)
Shipped: `planDispatch()` (pure, 24-test suite in `server/tests/dispatch.test.js`) + transactional applier `coreDispatchApprovedRequests()`; scheduled departures as per-departure-capped trips; earliest-deadline-first; van/bus sizing tie-break; scheduler-configurable `max_delay_minutes`/`max_earliness_minutes` (30/60); per-request decision log in the UI; FR-07 guarded writes; `DISPATCHED` auto-transition; `bus_assignments.departure_time` (migration 006 — run it in Supabase). Also fixed: datetime-local inputs are now interpreted as IST campus time, not server-UTC.
Remaining from the original Phase 1 list: none blocking; trip-merging economics (7.2) and cost scoring (6.10) are Phase 4.

### Phase 0.5 — Go-live dry run (checklist for the day before students arrive)
**Code ✅ shipped in `998bb8d`** ("Your ride" card, vehicle_type in lists, Login Security monitor); the dry run itself executes once the SQL lands on the right DB:
1. **Import a real batch** — Admin → Students & Passwords → paste roll numbers + names → set the default password → Import. Confirm the report says how many imported vs skipped.
2. **Hand out the default in person** (notice board / WhatsApp screenshot in person — never a broadcast group). Do NOT send it in a way a stranger could see.
3. **Watch one forced change** — a student logs in with the default → the "Set your password" screen appears → they change it → portal opens. Verify the badge flips to "active" in the admin student list.
4. **Exercise admin reset** — have one student "forget"; admin resets from the student row; student logs in with the new default and changes it again.
5. **Run Dispatch** — approve a handful of test requests, scheduler runs Dispatch with default windows; check the report reads sensibly and My Requests shows "Your ride: Bus #X — the 7:45 AM run".
6. **Check Login Security** — intentionally fat-finger a password 8 times; confirm the account blocks, the admin monitor shows it, unblock works.

### Phase 2 — Conductor mode & occupancy truth (§4.5, §7.3–7.5, §7.15–7.17, WR-01–07) — ✅ CODE DONE (2026-09-15) · latent occupancy 500 fixed 2026-09-15 (see Phase 3 note)
Shipped: `conductor` staff role (migration 008 seeds it with the bootstrap password — **admin must change it**); `occupancy_events` audit table; `POST /api/occupancy` (guard/conductor/admin) with WR-01 (dispatched vehicles only), WR-02 (FR-07 guard both directions + per-departure cap), WR-05 (every event logged with actor), WR-06 (walk-ins visible in the trip log), WR-07 (validator errors, never silent); no-shows release the seat and reject the booking (7.3); `GET /api/occupancy/trip/:bus` manifest; full Conductor portal (pick trip → walk-in → manifest → no-show from manifest). 18-check validator suite. **Needs migration 008 on the production DB before use.**
Remaining for full §7.5: checked-in vs reserved distinction in student-facing seat counts (minor).

### Phase 3 — Live tracking & dynamic insertion (§7.18–7.26, FR-16/17, 6.7/7.7) — ✅ CODE DONE (2026-09-15)
- Full design in **[TRIPS_GPS_DESIGN.md](TRIPS_GPS_DESIGN.md)**; all six build steps shipped.
- **Steps 1–2:** migration 009 (`trips` keyed on the existing `(bus_number, departure_time)` identity + `trip_positions` + `route_stops` coordinates); pure `canTransition()` lifecycle (`SCHEDULED→BOARDING→DEPARTED→EN_ROUTE→COMPLETED`/`CANCELLED`) with auto `ON_TRIP`/`AVAILABLE` flips and same-path completion of remaining bookings; routes start/state/current; conductor **Trip Status** screen. Bonus fix: `parseCampusLocal` was never imported in `server.js` — every real Phase-2 occupancy POST would have 500'd.
- **Steps 3–4:** `POST /api/trips/:id/position` (5 s server dedupe, plausibility check, 7-day prune); public **Live Buses** board (30 s auto-refresh, 90 s staleness — "last seen X min ago", never extrapolated; degrade-to-empty ONLY on missing table, real outages surface as errors); conductor 📡 share toggle (15 s client throttle, hidden-tab pause, stops on completion/cancel); **join-running-bus** — pure `validateJoin()` (corridor-membership route+direction via `route_stops` coordinates with 500 m walk tolerance; window ≤30 min past; per-departure cap; stop-passed via fresh-fix projection) + transactional `coreJoinTrip()` with the FR-07 atomic seat claim; join UI on the live board.
- **Verified:** 43 pure checks (`joinflow.test.js`) + 11 gate checks (`join.gates.test.js`) on top of steps 1–2's 29+14. Stop-order design question RESOLVED (coordinate-driven, fail-safe).
- **Needs on the production DB:** the updated `apply_all_pending.sql` (sanity grid now 14 columns, ending `trips_table 1 · trip_positions_table 1 · route_stops_seeded 4`). **Also ground-truth the approximate `route_stops` coordinates** in migration 009 against a real map and UPDATE them — every join decision derives from them.
- Remaining polish (Phase 4 territory): ETAs from position history, dead-trip detection, maps rendering.

### Phase 4 — Intelligence & efficiency (§7.1, 7.2, 7.6, 7.8, 7.9, 7.11, 7.12)
- Demand history + simple prediction, trip merging, fixed-segment ETAs, priority flag, efficiency dashboard, anti-starvation threshold, dead-trip detection.

---

## 8. Engineering guardrails (do not regress)
- Every async Express route stays wrapped in `ah()` (Express 4 won't catch throws).
- `db.query` returns `[rows, rowCount]` — check `rowCount` on UPDATE/DELETE.
- `vercel.json` stays minimal (a deprecated key once broke git builds).
- Supabase access only via the **pooler** host/port 6543.
- Migrations are idempotent and applied via SQL Editor (DB credentials are Vercel-Sensitive — the CLI cannot pull them).

## 9. Verification status of shipped work
- `node --check` clean on all server files and the inline frontend script.
- **Automated test suites** (`node server/tests/*.test.js`): dispatch planner 24 checks; rate limiter 18 checks — all passing.
- Admin-managed passwords: 17 behavioral checks against the real app (route removal, role gates, import validation, and the must-change-password middleware gate) — all passing.
- Phase 0.5 shipped: student "Your ride" card, admin Login Security monitor (`GET/DELETE /api/admin/login-failures`), go-live dry-run checklist (above).
- FR-03: 10 scenarios tested (boundary, past, invalid, skew margins).
- Timetable/live-refresh: 8 next-departure scenarios + 7 poller behaviors tested (initial paint, stale-fetch discard, failure/retry, mode toggle, timer teardown).
- **Deployed `998bb8d` (2026-09-15):** dispatch engine + rate limiter + Phase 0.5 are live in production; verified the limiter fails open on the un-migrated DB (401 not 500). **Still blocked:** request lists + timetable data + dispatch runs need `apply_all_pending.sql` (002–007) executed on the production DB — see the Phase 0 blocker.
