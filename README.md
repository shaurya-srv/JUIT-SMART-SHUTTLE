# JUIT Smart Shuttle

A smart hostel shuttle request and verification system designed to improve transportation between JUIT Solan's campus and its off-campus hostels. Data is persisted in **MySQL/MariaDB** (local) or **PostgreSQL via Supabase** (Vercel deployment).

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

### Local deployment (C server)

```bash
export SHUTTLE_DB_PASS=yourpassword   # required
make api       # builds shuttle_api.exe
./shuttle_api.exe   # listens on 127.0.0.1:8080 (loopback only)
```

### Vercel deployment (Node.js server)

```bash
cd server
npm install
SHUTTLE_DB_PASS=yourpassword node server.js
```

### Environment variables for Vercel

Set these in the Vercel dashboard (Settings → Environment Variables):

| Variable | Value | Description |
|---|---|---|
| `SHUTTLE_DB_HOST` | Your Supabase database host | e.g., `db.xxxxx.supabase.co` |
| `SHUTTLE_DB_USER` | Your Supabase database user | e.g., `postgres` |
| `SHUTTLE_DB_PASS` | Your Supabase database password | Found in Supabase dashboard |
| `SHUTTLE_DB_NAME` | `postgres` | Supabase default database |
| `SHUTTLE_DB_PORT` | `5432` | PostgreSQL port |
| `JWT_SECRET` | A strong random string | For signing JWT tokens |

### Setting up Supabase

1. Create a free account at [supabase.com](https://supabase.com)
2. Create a new project
3. Go to **Settings** → **Database** → copy the connection details
4. Open the **SQL Editor** and paste the contents of `server/supabase-schema.sql`
5. Copy the connection details into your Vercel environment variables

## Security

- **No credentials in source**: the `SHUTTLE_DB_PASS` environment variable is
  required — both CLI and API server refuse to start without it. No passwords
  are compiled into the binaries.
- **Passwords** are never stored in plaintext: PBKDF2-HMAC-SHA256, 60,000
  iterations, per-user random 16-byte salt. Legacy plaintext rows
  from the text-file migration upgrade automatically on the first successful
  login.
- **JWT tokens** (Vercel) or **CSPRNG session tokens** (local) with 8-hour expiry.
- **Parameterized queries** prevent SQL injection in both C (mysql_real_escape_string)
  and Node.js ($1 placeholders with pg).
- **Assignments are atomic**: seat count and assignment row change together in a
  transaction with a capacity guard.
- **Connection pool**: each API thread/connection gets its own database connection,
  eliminating serialization and enabling true concurrent request handling.

## Database Schema

| Table | Purpose |
|-------|---------|
| `students` | Registered students (roll number unique, PBKDF2 password hash) |
| `credentials` | Role passwords for guard and scheduler portals (PBKDF2 hashes) |
| `pickup_requests` | Shuttle requests with status (`PENDING_APPROVAL`, `APPROVED`, `REJECTED`) |
| `buses` | Registered buses with route and capacity |
| `bus_assignments` | Request-to-bus mapping (one assignment per request) |

## Tests (C backend)

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

### Configure connection
The client reads these environment variables:
```
SHUTTLE_DB_HOST=127.0.0.1   # optional, default shown
SHUTTLE_DB_USER=root         # optional, default shown
SHUTTLE_DB_PASS=<required>   # mandatory — server exits if not set
SHUTTLE_DB_NAME=shuttle_db   # optional, default shown
SHUTTLE_DB_PORT=3306         # optional, default shown
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
server/
  server.js         — Express.js API server (Vercel deployment)
  lib/
    db.js           — PostgreSQL connection pool (pg)
    crypto.js       — PBKDF2 hashing + CSPRNG (Node.js crypto)
    service.js      — Business logic (mirrors src/core/service.c)
    models.js       — Location constants and route validation
  supabase-schema.sql — Database schema for Supabase
  vercel.json       — Vercel deployment configuration
tests/              — unit tests (in-memory db stub, no MySQL needed)
index.html          — web frontend (calls the API)
ARCHITECTURE.md     — design decisions and phased plan
```
