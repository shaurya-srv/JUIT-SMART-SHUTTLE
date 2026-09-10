# JUIT Smart Shuttle — Architecture Plan

> Status: **PLAN** (agreed 2026-09-10). Web role: **C HTTP/JSON API**. Code layout: **split modules**.
> Deferred items (do not block the plan): SQL string-escaping hardening, mingw32-make toolchain fix.

## 1. Current state (what exists today)

| Component | Location | State |
|---|---|---|
| CLI app (all portals + business logic) | `index.c` (~624 lines) | Works; menus, assignment algorithm, and DB calls are interleaved |
| MySQL data-access layer | `database.c` / `database.h` | Works; schema creation, one-time text-file migration, all queries |
| Web frontend | `index.html` (~800 lines) | Full duplicate of the domain in JS on `localStorage` — disconnected from real data |
| Legacy text storage | `*.txt` data files | Obsolete; read once by the migration step |

**Core problem:** business logic exists twice (C + JS) over two storage systems (MySQL + localStorage).
Nothing connects the web UI to the real database.

## 2. Target architecture

```
┌────────────────────────────────────────────────────┐
│ Clients                                            │
│  shuttle.exe (CLI portals)     browser (index.html)│
└──────────────┬──────────────────────┬──────────────┘
               │ function calls       │ HTTP + JSON
┌──────────────▼──────────────────────▼──────────────┐
│ api/  HTTP/JSON server (winsock2)                  │
│   route dispatch, JSON parse/serialize, auth token │
├────────────────────────────────────────────────────┤
│ core/  Service layer — the ONE copy of the rules   │
│   • request lifecycle: PENDING → APPROVED/REJECTED │
│   • bus-assignment algorithm + capacity checks     │
│   • auth/verification                              │
├────────────────────────────────────────────────────┤
│ db/  Data-access layer (database.c) — MySQL only   │
│   schema, migration, queries                       │
└────────────────────────────────────────────────────┘
```

Rules:
- `core/` never prints or reads input; it takes/returns structs. Clients render.
- `db/` is the only place that speaks SQL.
- `api/` and `cli/` are thin shells over `core/`; no rule may live in either.
- MySQL is the single source of truth. localStorage is gone.

## 3. Proposed layout

```
shuttle/
├── src/
│   ├── main.c              — entry + wiring (CLI mode; API mode later)
│   ├── cli/
│   │   ├── student.c       — registration, portal, request creation, status view
│   │   ├── guard.c         — pending-queue processing, approve/reject menus
│   │   └── scheduler.c     — bus registration, assignment trigger, reports
│   ├── core/
│   │   ├── service.c/.h    — business rules: lifecycle transitions, assignment, capacity
│   │   └── models.h        — shared structs (student, request, bus, assignment)
│   ├── db/
│   │   ├── database.c/.h   — current DAL, moved as-is
│   │   └── (later: split per entity)
│   └── api/
│       ├── server.c        — winsock2 listen loop, request routing
│       ├── json.c/.h       — minimal JSON encode/decode
│       └── handlers.c      — endpoint → core-service glue
├── tests/
│   ├── test_assignment.c   — assignment algorithm edge cases
│   └── test_lifecycle.c    — status-transition rules
├── Makefile                — builds shuttle.exe (CLI) and shuttle_api.exe (API)
├── index.html              — rewritten to call the API
└── ARCHITECTURE.md         — this file
```

## 4. Phased plan

### Phase 1 — Extract core (no behavior change) — **DONE 2026-09-10**
1. ✅ `src/core/models.h`: shared structs (`student`, `pickuprequest`, `bus_t`,
   `request_route_t`), LOC_* constants, capacity limits.
2. ✅ Assignment algorithm moved out of `assignRequests()` into
   `core_assign_approved_requests()` with a `core_assign_result_t` outcome struct;
   the CLI function is now a thin renderer.
3. ✅ Lifecycle transitions wrapped as `core_approve_request()` / `core_reject_request()`.
4. ✅ Location rules moved to `core_location_from_name()` / `core_direction()` /
   `core_route_is_valid()`; CLI helpers delegate to them.
5. ✅ New db loaders: `db_get_buses()`, `db_get_request_routes_by_status()`, `db_count_buses()`.
6. ✅ Bonus: the mingw32-make failure was root-caused — gcc's cc1.exe needs
   `C:/msys64/mingw64/bin` on PATH — and fixed in the Makefile (`make` now works).
   Build verified: `mingw32-make` clean with -Wall -Wextra; smoke run connects and
   migrates against the live DB.

### Phase 2 — Split CLI
1. Split `index.c` into `cli/student.c`, `cli/guard.c`, `cli/scheduler.c` + `main.c`.
2. `db/` moves to `src/db/` unchanged.

### Phase 3 — HTTP/JSON API (new)
1. `api/server.c`: winsock2 listener on `127.0.0.1:8080`, one thread per connection,
   routes:
   | Method | Path | Purpose |
   |---|---|---|
   | POST | /api/login | student/guard/scheduler auth |
   | POST | /api/requests | create pickup request |
   | GET | /api/requests?status= | list by status (guard/scheduler) |
   | GET | /api/requests/mine | student's own requests |
   | POST | /api/requests/{id}/approve · /reject | guard actions |
   | GET/POST | /api/buses | list / register buses |
   | POST | /api/buses/assign | run assignment algorithm |
   | POST | /api/assignments/unassign | remove assignment |
   | GET | /api/reports/capacity | route capacity summary |
2. `api/json.c`: minimal encode/decode (no external deps).
3. Auth: password check via `core/`, session token in memory; plaintext passwords
   must be hashed before this ships (see §6).
4. `index.html` rewritten: same UI, `fetch()` calls replace the localStorage layer.

### Phase 4 — Hardening
1. Transactions: assignment capacity check + insert atomic; stop `MAX(request_number)+1`
   (use the existing `AUTO_INCREMENT id`).
2. Password hashing (salted) for students + role credentials.
3. SQL string escaping audit across `db/` (the deferred fix).
4. Unit tests for `core/` (assignment edges: full buses, mixed routes, unassign/refill).

## 5. Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-10 | Web served by a C HTTP API | One language end-to-end; reuses `core/` + `db/` directly |
| 2026-09-10 | Split module layout (cli/core/db/api) | Testable business rules; CLI and API share one implementation |
| 2026-09-10 | SQL escaping + make fix deferred | User asked to defer; plan does not depend on them |

## 6. Risks / notes

- MySQL password currently hard-coded in `main()` (env-var override added; consider
  removing the compiled default before any deployment).
- `mysql_real_connect` per process: CLI is fine; the API server should open a
  connection per worker thread or use a small pool.
- `conio.h` (`getch`) is Windows-only — CLI stays Windows-only, which matches the
  current environment; `api/` has no such dependency.
