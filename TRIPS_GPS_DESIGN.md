# Phase 3 Design — Trips Entity & Conductor GPS Sharing

> Design for PRD §7.18–7.26 (live tracking, conductor GPS mode, join-running-bus),
> FR-16/17 (dynamic insertion), 6.7/7.7 (insertion decision engine), and the
> `ON_TRIP` half of 7.13. Written 2026-09-15, grounded in the shipped schema
> (migrations 001–008) and shipped patterns (FR-07 guard, occupancy_events,
> decision logs, graceful degradation).

---

## 1. Core insight: a trip identity already exists

Phase 2's `occupancy_events` already identifies a trip as **`(bus_number, departure_time TIMESTAMPTZ)`**,
and Phase 1's `bus_assignments.departure_time` (migration 006) scopes bookings the same way.
Phase 3 does **not** replace that key — the `trips` table adopts it via a `UNIQUE`
constraint, so old rows keep working untouched and a trip row can be attached
retroactively at any time.

The PRD's full stop-sequence insertion engine (§6.7) is deliberately **out of scope
for v1**: routes are linear hostel↔JUIT runs with fixed stops, so "hard constraints"
reduce to capacity + route/direction + "has the bus passed the student's pickup
point yet" — all checkable without a routing engine.

## 2. Migration 009 — two tables, no changes to existing ones

```sql
CREATE TABLE IF NOT EXISTS trips (
  trip_id         BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  bus_number      INTEGER NOT NULL REFERENCES buses(bus_number),
  departure_time  TIMESTAMPTZ NOT NULL,            -- the scheduled run (IST campus time)
  route_pickup    INTEGER NOT NULL,
  route_dropoff   INTEGER NOT NULL,
  state           VARCHAR(12) NOT NULL DEFAULT 'SCHEDULED'
                  CHECK (state IN ('SCHEDULED','BOARDING','DEPARTED','EN_ROUTE','COMPLETED','CANCELLED')),
  boarded_count   INTEGER NOT NULL DEFAULT 0,      -- ground truth (check-ins + walk-ins)
  actual_departure TIMESTAMPTZ,
  actual_arrival  TIMESTAMPTZ,
  created_by      VARCHAR(60),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bus_number, departure_time)              -- == the occupancy_events identity
);

CREATE TABLE IF NOT EXISTS trip_positions (
  position_id  BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  trip_id      BIGINT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  accuracy_m   DOUBLE PRECISION,
  speed_mps    DOUBLE PRECISION,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_positions_latest
  ON trip_positions(trip_id, recorded_at DESC);
```

Notes:
- **Thin entity**: `trips` rows are created lazily (conductor starts boarding / bus
  departs) — a departure nobody tracks never gets a row, and every Phase 1/2 flow
  works with zero trips rows (same fail-soft rule as 004/006 hardening).
- **Positions are INSERT-only** — doubles as demand/route history for Phase 4 ETAs.
  Prune `recorded_at < now() - interval '7 days'` opportunistically on each POST
  (bounded `DELETE`, no cron needed on Vercel).

## 3. Trip lifecycle (state machine)

```
SCHEDULED ──start──▶ BOARDING ──depart──▶ DEPARTED ──enroute──▶ EN_ROUTE ──arrive──▶ COMPLETED
   │                    │                    │                                  
   └──────────── cancel ◀────────────────────┘        (CANCELLED anytime before COMPLETED)
```

- `start` (conductor/guard/admin): creates-or-attaches the trip row; conductor portal's
  existing "pick my trip" list feeds it.
- `depart`: stamps `actual_departure`, flips **`buses.state → ON_TRIP`** (closes the
  auto half of 7.13; dispatch already sets `DISPATCHED`).
- `arrive`: stamps `actual_arrival`, `buses.state → AVAILABLE`, completes remaining
  APPROVED bookings on that departure (same completion path the guard uses today).
- Transitions are one-way except `CANCELLED`; every change is validated by a **pure
  `canTransition(from, to)`** — unit-testable, no DB.

## 4. Conductor GPS sharing flow

1. **Opt-in per trip**: conductor taps "Share live location" on their picked trip →
   browser `navigator.geolocation.watchPosition` (HTTPS ✓ on Vercel). If permission
   is denied, the trip simply runs untracked — everything else works.
2. **Client throttle**: POST `/api/trips/:id/position` every **15 s** while the tab is
   open (pause on `visibilitychange` hidden — honest battery trade-off; OS-level
   throttling may stretch intervals, which staleness handling covers).
3. **Server guardrails (§7.23)**: only the trip's active conductor/guard/admin may post;
   server dedupes fixes < 5 s apart; `accuracy_m` stored and surfaced, fixes worse
   than 1 km still stored but flagged.
4. **Serving to students**: `GET /api/trips/active` returns, per active trip
   (`state IN (BOARDING, DEPARTED, EN_ROUTE)`): bus number/type, route, state, seats,
   **latest fix + age**. Same privacy posture as `/api/timetable/public` — active
   trips only, never historical positions, never student data.
5. **Staleness (§7.18)**: `age > 90 s` ⇒ fix is stale. UI shows "last seen X min ago",
   never extrapolates/blends, and join recommendations never rely on a stale fix.

## 5. Join-running-bus & dynamic insertion (FR-16/17, §7.26)

`POST /api/trips/:id/join` (student, own request) attaches an APPROVED request to a
running trip. Hard constraints, checked in order, each failure returning **409 with
the specific reason** (never silent — WR-07 discipline):

1. **Route/direction match** — request's pickup→dropoff equals the trip's (reuse
   dispatch's route predicate).
2. **Capacity** — FR-07 guarded UPDATE against the per-departure cap (Phase 1's
   accounting), plus `boarded_count` never exceeding `max_capacity`.
3. **Pickup point not passed** — v1 rule: allowed while `state ∈ (SCHEDULED, BOARDING)`
   or, once `EN_ROUTE`, only if the latest non-stale fix is still geographically
   before the student's pickup point. **Resolved:** stop order is never assumed
   from location indexes — `route_stops` (migration 009) holds coordinates and
   the join check derives order by corridor projection; request endpoints must
   lie within a ~500 m walk of the trip's corridor in the right direction
   (so a Ravli PG student may board the Peach Tree → JUIT bus). Unmapped
   coordinates fail SAFE (reject), never guess.
4. **Service window** — request's `required_time` still in the future.

Success marks the request `APPROVED→assigned` with `departure_time` set (006 column),
logs a decision entry (7.7/7.10 pattern), and bumps seats. Failure tells the student
why and offers the normal request flow — the **safe fallback the PRD demands (FR-17)**.

## 6. API surface (all `ah()`-wrapped, role-gated, fail-soft on old DBs)

| Route | Roles | Purpose |
|---|---|---|
| `POST /api/trips/start` | conductor/guard/admin | create-or-attach trip for `(bus, departure)` |
| `POST /api/trips/:id/state` | conductor/guard/admin | lifecycle transitions (validated) |
| `POST /api/trips/:id/position` | conductor/guard/admin | GPS ingest (15 s client throttle, 5 s server dedupe) |
| `GET /api/trips/active` | public | live board: active trips + latest fix + age; degrades to an empty board **only** when the trips table is missing — a DB outage surfaces as an error, never a fake-empty board |
| `POST /api/trips/:id/join` | student (own request) | guarded dynamic insertion |
| `GET /api/trips/current` | conductor/guard/admin (+scheduler read) | lifecycle state of one run |

Built: all of the above (2026-09-15). Coordinate math lives in `server/lib/geo.js`
(pure: haversine, corridor projection, stop-passed, staleness, dedupe, plausibility);
the join rule lives in the pure `validateJoin()` (specific rejection codes, walking-
distance corridor membership for route/direction); capacity moves only through the
FR-07 guarded UPDATE inside the transactional `coreJoinTrip()`. Suites:
`server/tests/joinflow.test.js` (43 pure checks) + `server/tests/join.gates.test.js`
(11 live gate checks) + `trips.test.js`/`trips.gates.test.js` (steps 1–2).

## 7. Build order (each step independently deployable)

1. ~~**Migration 009** + fold into `apply_all_pending.sql`~~ ✅ (grid now 14 columns:
   `… trips_table 1 · trip_positions_table 1 · route_stops_seeded 4`)
2. ~~**Trip lifecycle**~~ ✅ pure state machine + routes + conductor buttons
3. ~~**GPS ingest + live board**~~ ✅ position endpoint (guardrails), public
   `/api/trips/active`, student **Live Buses** view (30 s auto-refresh,
   stale = "last seen X min ago"), conductor 📡 share toggle (15 s throttle,
   pauses on hidden tab, stops on completion)
4. ~~**Join flow**~~ ✅ `validateJoin()` + `coreJoinTrip()` + student UI
   (request-number join from the live board)
5. ~~**Tests**~~ ✅ 43 pure checks + 11 gate checks (+29+14 from steps 1–2)
6. ~~**Docs**~~ ✅ this file, ROADMAP, ARCHITECTURE

## 8. Explicit non-goals for v1

- No maps SDK / polyline rendering — the live board is data-first (campus scale,
  3 routes); a map is Phase 4 polish if wanted.
- No websocket/streaming — serverless request/response + 15–30 s client polling
  matches the existing 60 s timetable poller pattern.
- No driver smartphone app — conductor GPS runs in the existing mobile web portal.
- No ETA promises — positions + ages only; ETAs need Phase 4 history.
