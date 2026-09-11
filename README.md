# JUIT Smart Shuttle

A C-based smart hostel shuttle request and verification system designed to improve transportation between JUIT Solan's campus and its off-campus hostels. Data is persisted in **MySQL/MariaDB** (replacing the original text-file storage).

## Overview

Due to increased hostel occupancy, students may be accommodated in hostels located outside the main campus. This creates a need for an efficient shuttle transportation system that can handle dynamic student pickup requests without unnecessary trips or fuel consumption.

The system allows:
- Students to register, log in, and submit shuttle pickup requests.
- Guards to review pending requests and approve or reject them.
- Bus schedulers to register buses with routes and capacity limits.
- Automatic assignment of approved requests to buses on matching routes.
- Route-based capacity tracking and management.

## System Workflow

```
Student Portal
│
│ Create Pickup Request
▼
Request Created (PENDING_APPROVAL)
│
▼
Guard Portal
│
│ Verify & Approve/Reject
▼
APPROVED ──► Bus Scheduler Portal
│                │
│         Register Buses
│         Auto-Assign to Buses
│         View Capacity
▼
REJECTED
```

## HTTP/JSON API (web)

`index.html` is a browser client for the same workflow — it calls a small HTTP/JSON
server built from the same `core/` and `db/` layers:

```bash
make api       # builds shuttle_api.exe
./shuttle_api.exe   # listens on 127.0.0.1:8080 (loopback only)
```

Then open `index.html` in a browser. Endpoints: `/api/health`, `/api/login`,
`/api/register`, `/api/requests` (+ `/mine`, `/{id}/approve`, `/{id}/reject`),
`/api/buses`, `/api/buses/assign`, `/api/assignments/unassign`,
`/api/reports/capacity`.

## Security

- **Passwords** are never stored in plaintext: PBKDF2-HMAC-SHA256, 60,000
  iterations, per-user random 16-byte salt (Windows CNG). Legacy plaintext rows
  from the text-file migration upgrade automatically on the first successful
  login. Portal passwords seeded on first run (`guard123`, `scheduler123`) are
  hashed like any other — change them via the app.
- **Session tokens** are 128-bit CSPRNG values with an 8-hour sliding expiry.
- **All user strings** are escaped with `mysql_real_escape_string` before they
  reach SQL; request statuses are validated against a whitelist at the API layer.
- **Assignments are atomic**: seat count and assignment row change together in a
  transaction with a capacity guard, so concurrent assignment runs cannot
  overfill a bus.

## Database Schema

| Table | Purpose |
|-------|---------|
| `students` | Registered students (roll number unique, PBKDF2 password hash) |
| `credentials` | Role passwords for guard and scheduler portals (PBKDF2 hashes) |
| `pickup_requests` | Shuttle requests with status (`PENDING_APPROVAL`, `APPROVED`, `REJECTED`) |
| `buses` | Registered buses with route and capacity |
| `bus_assignments` | Request-to-bus mapping (one assignment per request) |

## Tests

```bash
make test          # core: assignment algorithm + lifecycle transitions (10 tests)
make test-crypto   # crypto: PBKDF2 hashing + CSPRNG (6 tests)
```

Both run against an in-memory stub — no MySQL server required.

## How to Compile and Run

### Prerequisites
- **MSYS2** with the mingw64 toolchain and MariaDB Connector/C:
  ```bash
  pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-libmariadb
  ```
- A running MySQL/MariaDB server (tested on `127.0.0.1:3306`).

### Build
```bash
make        # or: mingw32-make
```

### Configure connection (optional)
The client reads these environment variables (defaults shown):
```
SHUTTLE_DB_HOST=127.0.0.1
SHUTTLE_DB_USER=root
SHUTTLE_DB_PASS=<set your password here>
SHUTTLE_DB_NAME=shuttle_db
SHUTTLE_DB_PORT=3306
```

### Run
```bash
./shuttle.exe
```
On first run it connects, creates the tables if missing, and migrates any existing data from the legacy text files (`studentregistration.txt`, `pendingrequest.txt`, `approvedrequest.txt`, `rejectedrequest.txt`) into the database.

### Default portal passwords
Guard and scheduler passwords are seeded on first run: `guard/guard123` and `scheduler/scheduler123` (change them in the `credentials` table).

## Project Structure

```
src/
  main.c            — CLI entry point + login page
  cli/              — per-portal UIs (student, guard, scheduler) + shared I/O
  core/             — business rules (assignment, lifecycle, locations) + crypto
  db/               — MySQL data-access layer (the only place that speaks SQL)
  api/              — HTTP/JSON server (winsock2) for the web frontend
tests/              — unit tests (in-memory db stub, no MySQL needed)
index.html          — web frontend (calls the API)
ARCHITECTURE.md     — design decisions and phased plan
```
