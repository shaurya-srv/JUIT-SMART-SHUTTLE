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

## Database Schema

| Table | Purpose |
|-------|---------|
| `students` | Registered students (roll number unique, password) |
| `credentials` | Role passwords for guard and scheduler portals |
| `pickup_requests` | Shuttle requests with status (`PENDING_APPROVAL`, `APPROVED`, `REJECTED`) |
| `buses` | Registered buses with route and capacity |
| `bus_assignments` | Request-to-bus mapping (one assignment per request) |

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

| File | Description |
|------|-------------|
| `index.c` | Main source: menus, portals, assignment logic |
| `database.c` / `database.h` | MySQL data-access layer (all DB queries) |
| `Makefile` | Build script (MSYS2 mingw64 toolchain) |
| `index.html` | Web frontend for the same workflow |
