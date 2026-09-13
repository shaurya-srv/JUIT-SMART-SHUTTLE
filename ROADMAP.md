# JUIT Smart Shuttle — PRD Implementation Roadmap

> Tracks the **JUIT Smart Shuttle PRD** (baseline + planned Intelligent Dispatch
> Optimization) against this repository. PRD sections are referenced as §n.
> Last verified against the code: **2026-09-14** — 22 Express routes,
> migrations 001–004 present, service exports confirmed.

**Status legend:** ✅ implemented · 🟡 partial · ❌ not started · 🔶 exists but needs hardening before real students onboard

---

## 1. Scorecard

| Area | Status | Summary |
|---|---|---|
| Baseline roles & request lifecycle (§2–5) | ✅ | All four roles, full lifecycle with preconditions |
| Functional requirements FR-01–08, 12–15 (§7) | ✅ | Auth, requests, capacity guard, auto-assign, timetable, reports, staff passwords |
| FR-03 booking cutoff | ✅ | Built on top of baseline (optional `required_time`) |
| Dispatch optimizer (§6, FR-09–11) | ❌ | Foundation ready, engine not started |
| Dynamic active-trip insertion (FR-16–17) | ❌ | Needs the trips entity |
| Conductor mode & walk-ins (§4.5, §7.15–7.17, WR-01–07) | ❌ | Role model ready to extend |
| Live GPS tracking (§7.18–7.26) | ❌ | Highest-risk PRD area (their own backlog flags it) |
| Non-functional requirements (§8) | ✅ / 🔶 | Core NFRs met; rate limiting & reset-password hardening outstanding |

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
| FR-09 | Optimizer combines requests into fewer trips | ❌ | Phase 1. Requires consuming `required_time` (stored, unused) |
| FR-10 | Prefer existing feasible trips | ❌ | Phase 1 — scheduled timetable departures become the first "existing trips" |
| FR-11 | Select vehicle size by demand | ❌ | Phase 1 — rule: 3–6 students → van, >6 → bus (§6.8); never exceed capacity |
| FR-12 | Timetable + live capacity to students | ✅ | `GET /api/timetable` (auth) + `GET /api/timetable/public` (no auth) + 60 s live refresh on the login-screen view (in-place repaint, generation guard, visibility catch-up) |
| FR-13 | Guard completes rides, frees seats | ✅ | `POST /api/requests/:id/complete`; seat decremented, assignment history kept |
| FR-14 | Scheduler monitors route capacity | ✅ | `GET /api/reports/capacity` (per-route assigned/capacity/available) |
| FR-15 | Admin manages staff passwords in-app | ✅ | `GET /api/admin/staff`, `POST /api/admin/staff-password` (min 8 chars, hashed) |
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
| 6.2 | Planning window | 🟡 | Window exists implicitly (cutoff → departure); no process consumes it yet |
| 6.3 | Optimization objective & priorities | ❌ | Phase 1 — order: safety/capacity → student times → route compatibility → existing trips → fewest trips → smallest vehicle |
| 6.4 | Shared-trip grouping | ❌ | Phase 1 — group by (direction, route segment, time window) |
| 6.5 | Earliest-deadline constraint | ❌ | Phase 1 — group dispatch time = earliest `required_time`; **not** an average |
| 6.6 | Existing-trip-first policy | ❌ | Phase 1 — check seeded timetable departures (later: planned trips) before creating new ones |
| 6.7 | On-route dynamic pickup/drop addition | ❌ | Phase 3 — insertion engine with hard constraints (FR-17) |
| 6.8 | Vehicle selection (van 3–6, bus >6) | 🟡 | `vehicle_type` column + capacity caps exist; sizing rule not applied |
| 6.9 | Maximum acceptable delay | ❌ | Phase 1 — scheduler-configurable window; never schedule later on purpose |
| 6.10 | Trip cost/score comparison | ❌ | Phase 1 — keep-existing vs new-trip score (operating cost, distance, waiting, lateness) |
| 6.11 | Recommended dispatch flow (11 steps) | ❌ | Phase 1 implements steps 1–11 minus active-trip steps (those land in Phase 3) |

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
| 7.10 | Explainable dispatch decisions | 🟡 | Assignment report counts reasons; decision-level explanations land with the optimizer |
| 7.11 | Fairness / anti-starvation | ❌ | Max-wait threshold forces dispatch even when uneconomical |
| 7.12 | Route utilization & dead-trip detection | ❌ | Phase 4 — flags low-occupancy departures & empty return legs |
| 7.13 | Vehicle operational state | 🟡 | Column + CHECK constraint + auto-assign guard + `PATCH /api/buses/:n/state` + UI badges; **missing:** automatic `DISPATCHED`/`ON_TRIP` transitions during dispatch |
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
| Traceable scheduling decisions | 🟡 | Reports exist; decision audit arrives with the optimizer |
| **Password reset hardening** | 🔶 | `POST /api/reset-password` is still unauthenticated (roll number + new password) — **must fix before onboarding students** |
| **Login rate limiting** | ❌ | Brute-force protection for staff passwords |
| **DB password rotation** | ❌ | Old credential appeared in chat; rotate in Supabase + Vercel |

---

## 7. Recommended Build Order

### Phase 0 — Ship what exists (now)
1. Apply migrations **002, 003, 004** in Supabase SQL Editor (idempotent; 004 adds dispatch columns + van backfill).
2. Deploy (`git push`), verify `/api/timetable/public` returns 24 departures and the login-screen live view works.
3. Security quick wins before students arrive: protect reset-password, add login rate limiting, rotate `SHUTTLE_DB_PASS`.

### Phase 1 — Dispatch engine v1 (FR-09/10/11, §6.3–6.11, finishes 7.13)
- Consume `required_time`: pool APPROVED requests by (direction, route); sort by earliest deadline.
- Treat **scheduled timetable departures as existing trips** (6.6) — assign groups into them first.
- Van for 3–6 students, bus for >6 (6.8); never exceed capacity; respect per-student max delay (6.9).
- Output an **explainable decision report** (7.10): per request — which trip, why, what was skipped.
- Auto-set vehicle state `DISPATCHED` at dispatch time (completes 7.13).
- *Acceptance:* seeded timetable + a batch of approved requests → "Run Dispatch" fills the 07:45/08:15 departures by route, picks vans for small groups, produces a per-request decision log, and never over-caps or schedules past a max-delay window.

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
- `node --check` clean on `server/server.js`, `server/lib/service.js`, and the inline frontend script.
- FR-03: 10 scenarios tested (boundary, past, invalid, skew margins).
- Timetable/live-refresh: 8 next-departure scenarios + 7 poller behaviors tested (initial paint, stale-fetch discard, failure/retry, mode toggle, timer teardown).
- No automated test suite yet — worth adding (node:test) as Phase 1 lands, since the optimizer is exactly the kind of code that needs regression tests.
