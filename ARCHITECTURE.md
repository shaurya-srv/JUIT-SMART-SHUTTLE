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

### Phase 2 — Split CLI — DONE (2026-09-10, commit e2cee0f)
1. DONE: Split `index.c` into `cli/student.c`, `cli/guard.c`, `cli/scheduler.c` + `main.c`.
2. DONE: `db/` moves to `src/db/`; added `db_get_pending_request_summaries()` so the CLI no longer touches SQL directly.
3. DONE: Makefile rewritten for the `src/` layout (build dir, header deps); verified with a clean build and a smoke run against the live DB. CLI code no longer includes mysql.h.

### Phase 3 — HTTP/JSON API — **ENDPOINTS COMPLETE 2026-09-10**
1. ✅ `src/api/server.c`: winsock2 listener on `127.0.0.1:8080` (loopback only),
   one thread per connection, all handlers serialized under a CRITICAL_SECTION
   (the DAL's single MYSQL* is not thread-safe — pool is the Phase 4 upgrade).
   Built as `shuttle_api.exe` via `make api`. Live-tested with curl:
   health, login (all three roles, plus bad-credential/method/role paths),
   request creation (real DB write, token auth, role enforcement, route
   validation), 404.
   Routes implemented so far:
   | Method | Path | Purpose | Status |
   |---|---|---|---|
   | GET/POST | /api/health | liveness + DB ping | ✅ done |
   | POST | /api/login | student/guard/scheduler auth, returns session token | ✅ done |
   | POST | /api/requests | create pickup request (Bearer token, student role) | ✅ done |
   | GET | /api/requests?status= | list by status (guard/scheduler) | ✅ done |
   | GET | /api/requests/mine | student's own requests | ✅ done |
   | POST | /api/requests/{id}/approve · /reject | guard actions, 409 if not pending | ✅ done |
   | GET/POST | /api/buses | list / register buses (scheduler) | ✅ done |
   | POST | /api/buses/assign | run assignment algorithm (scheduler) | ✅ done |
   | POST | /api/assignments/unassign | remove assignment (scheduler) | ✅ done |
   | GET | /api/reports/capacity | route capacity summary (scheduler/guard) | ✅ done |

   All endpoints live-tested with curl (21 checks): auth + role enforcement on
   every route, real DB writes (request created, approved, assigned to bus 1
   on exact route match, capacity reported, unassign rejected when not
   assigned), 409 conflict on re-approve, 404 on unknown request.
   Supporting DAL additions: `request_row_t`, `db_get_request_rows_by_status()`,
   `db_get_request_rows_by_student()`, `db_get_request_status()`.
   Lifecycle hardened: `core_approve/reject_request()` now refuse non-pending
   requests (was a bare status overwrite).
2. ✅ `src/api/json.{h,c}`: minimal flat-object parser (string/int) and escaper,
   no external deps.
3. ✅ Scaffold auth: password check via db, in-memory session table (rand-based
   tokens — replaced with CSPRNG + expiry in Phase 4).
4. ✅ `index.html` rewritten: same UI, `fetch()` calls to `shuttle_api` replace the
   localStorage layer (only the session token persists locally). All portals —
   student, guard, scheduler — now read/write real MySQL data. Server gained
   CORS (preflight + headers) and Content-Length-aware body reads for browser
   clients; new public `POST /api/register` mirrors CLI registration.

### Phase 4 — Hardening — **DONE 2026-09-10**
1. ✅ **Session tokens**: 128-bit CSPRNG hex tokens via Windows CNG
   (`crypto_random_bytes`), 8-hour sliding expiry, expired sessions lazily
   invalidated (`src/api/handlers.c`). Sessions remain in-memory (lost on
   restart — acceptable for this deployment).
2. ✅ **Password hashing**: PBKDF2-HMAC-SHA256, 60k iterations, 16-byte random
   salt (`src/core/crypto.c`, format `pbkdf2-sha256$<iter>$<salt>$<hash>`).
   Applied at registration and to role credentials. Legacy plaintext rows
   (migrated data) upgrade transparently on first successful login.
   Schema: password columns widened to VARCHAR(160).
3. ✅ **SQL escaping audit**: all remaining string→SQL paths escaped via
   `mysql_real_escape_string` — migration file text, status parameters
   (defensive, they are program constants), role lookup. Passwords are
   hash-strings escaped like any other input.
4. ✅ **Atomic assignments**: `db_assign_request_to_bus()` now does a
   capacity-guarded UPDATE (`WHERE current_count<max_capacity`) + assignment
   INSERT in one transaction — concurrent runs can never overfill a bus.
   `db_create_request()` allocates request numbers inside a transaction;
   `db_unassign_request()` is transactional. The whole assignment run is
   wrapped in one transaction (`core_assign_approved_requests`).
5. ✅ **Unit tests** (`make test` → 10/10, `make test-crypto` → 6/6):
   assignment algorithm (full-bus skip, exact-route match, 80% warning,
   db-failure resilience, empty inputs, NULL tolerance) + lifecycle
   transitions (pending→approved, non-pending refusals, unknown request) +
   crypto (round-trip, fresh salts, tamper rejection, malformed stored
   strings, CSPRNG distinctness). Runners need no MySQL server.

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
