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
| Conductor mode & walk-ins (§4.5, §7.15–7.17, WR-01–07) | ❌ | Role model ready to extend |
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
| FR-16 | Add approved requests to active/dispatched trips when feasible | ❌ | Phase 3 (needs `trips` entity + active-trip state) |
| FR-17 | Reject unsafe dynamic insertion (capacity / detour / service window) | ❌ | Phase 3 — hard constraints must fail safely into the normal request flow |

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
| 6.7 | On-route dynamic pickup/drop addition | ❌ | Phase 3 — insertion engine with hard constraints (FR-17) |
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
| 7.7 | Route-insertion decision engine | ❌ | Phase 3 (formalized 6.7) |
| 7.8 | Priority / emergency requests | ❌ | Staff-only flag; relaxes cost rules, never capacity/safety |
| 7.9 | Trip efficiency dashboard | ❌ | Phase 4 — trips run, occupancy, trips avoided, est. savings |
| 7.10 | Explainable dispatch decisions | ✅ v1 | Dispatch report renders a per-request decision log (vehicle, departure, reason) + per-departure fill counts |
| 7.11 | Fairness / anti-starvation | ❌ | Max-wait threshold forces dispatch even when uneconomical |
| 7.12 | Route utilization & dead-trip detection | ❌ | Phase 4 — flags low-occupancy departures & empty return legs |
| 7.13 | Vehicle operational state | ✅ v1 | Column + CHECK + auto-assign guard + `PATCH .../state` + UI; dispatch now auto-sets `DISPATCHED` on used vehicles (`ON_TRIP` arrives with Phase 3 GPS) |
| 7.14 | Maintenance tracking | 🟡 | `last_service`/`next_service` columns exist; no UI, no auto-exclusion by date |
| 7.15–7.17 | Walk-ins & manual seat adjustments | ❌ | Phase 2 (see WR table) |
| 7.18–7.26 | Live tracking, conductor GPS mode, join-running-bus | ❌ | Phase 3 — riskiest area: stale-location handling, privacy (§7.25), guardrails (§7.23) |

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

---

## 7. Recommended Build Order

### Phase 0 — Ship what exists (now)
1. **Two-database split — DECIDED 2026-09-15:** the **old project** stays the production DB (Vercel's pooler user `postgres` resolves there). The new project (`afydafeurljiqlnydywh`) is retired once `apply_all_pending.sql` has been run on the old one and production verifies green. The new project's copy of the data is a scratch copy — do not repoint Vercel to it.
2. Apply migrations **002–005** on the **old** project via `server/migrations/apply_all_pending.sql` (idempotent).
3. Security quick wins before students arrive: ~~protect reset-password~~ (done — admin-managed), ~~login rate limiting~~ (done — `login_failures` table), rotate `SHUTTLE_DB_PASS`.

### Phase 1 — ~~Dispatch engine v1~~ ✅ DONE (2026-09-15)
Shipped: `planDispatch()` (pure, 24-test suite in `server/tests/dispatch.test.js`) + transactional applier `coreDispatchApprovedRequests()`; scheduled departures as per-departure-capped trips; earliest-deadline-first; van/bus sizing tie-break; scheduler-configurable `max_delay_minutes`/`max_earliness_minutes` (30/60); per-request decision log in the UI; FR-07 guarded writes; `DISPATCHED` auto-transition; `bus_assignments.departure_time` (migration 006 — run it in Supabase). Also fixed: datetime-local inputs are now interpreted as IST campus time, not server-UTC.
Remaining from the original Phase 1 list: none blocking; trip-merging economics (7.2) and cost scoring (6.10) are Phase 4.

### Phase 0.5 — Go-live dry run (checklist for the day before students arrive)
1. **Import a real batch** — Admin → Students & Passwords → paste roll numbers + names → set the default password → Import. Confirm the report says how many imported vs skipped.
2. **Hand out the default in person** (notice board / WhatsApp screenshot in person — never a broadcast group). Do NOT send it in a way a stranger could see.
3. **Watch one forced change** — a student logs in with the default → the "Set your password" screen appears → they change it → portal opens. Verify the badge flips to "active" in the admin student list.
4. **Exercise admin reset** — have one student "forget"; admin resets from the student row; student logs in with the new default and changes it again.
5. **Run Dispatch** — approve a handful of test requests, scheduler runs Dispatch with default windows; check the report reads sensibly and My Requests shows "Your ride: Bus #X — the 7:45 AM run".
6. **Check Login Security** — intentionally fat-finger a password 8 times; confirm the account blocks, the admin monitor shows it, unblock works.

### Phase 2 — Conductor mode & occupancy truth (§4.5, §7.3–7.5, §7.15–7.17, WR-01–07)
- `conductor` role; walk-in recording, no-show marking, boarding check-in; `occupancy_events` audit table.
- All seat mutations flow through the FR-07 capacity guard; live occupancy distinguishes reserved / checked-in / walk-in.

### Phase 3 — Live tracking & dynamic insertion (§7.18–7.26, FR-16/17, 6.7/7.7)
- Introduce the **`trips` entity** (dispatchable trip instances with stop sequences) — the one true architectural addition left; Phase 1 deliberately avoids it by using scheduled departures.
- Conductor GPS sharing (browser geolocation), trip states `SCHEDULED → BOARDING → DEPARTED → EN_ROUTE → COMPLETED`, student-facing live bus view, guarded join/insertion with safe fallback to the normal request flow.

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
- **Pending deploy:** the dispatch engine + rate limiter code and migrations 006–007 are committed locally but not yet pushed; `apply_all_pending.sql` (002–007) has not been run on the old (production) project.
