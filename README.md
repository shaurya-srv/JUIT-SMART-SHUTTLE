# JUIT Smart Shuttle

A shuttle request and verification system for JUIT Solan students travelling
between the main campus and off-campus hostels (Ravli PG, Peach Tree,
Waknaghat). Students request seats, guards verify them, and the scheduler
assigns them to buses with live capacity tracking and a departure timetable.

**Live:** https://juit-smart-shuttle.vercel.app

## Features

| Role | Capabilities |
|---|---|
| Student | Register, login, create pickup requests, track status, view timetable with seats left |
| Anyone | Check the **public timetable** from the login screen — today's departures, next ride, live seat counts (no login) |
| Guard | Approve/reject pending requests, complete rides (frees the seat), view all lists |
| Scheduler | Register buses, auto-assign approved requests, route capacity report, edit departure timetable |
| Admin | Everything the scheduler can do + staff password management |

Request lifecycle: `PENDING_APPROVAL → APPROVED → COMPLETED` (or `REJECTED`).

## Quick start (local development)

```bash
npm install
export SHUTTLE_DB_HOST=aws-0-<region>.pooler.supabase.com   # or a local PG host
export SHUTTLE_DB_PORT=6543
export SHUTTLE_DB_USER=postgres.<your-project-ref>
export SHUTTLE_DB_NAME=postgres
export SHUTTLE_DB_PASS=yourpassword
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

node server/server.js          # API on http://127.0.0.1:3000
```

Open `index.html` in a browser for the frontend (it targets the deployed API
by default; see the `API` constant in `index.html` for local wiring).

Check connectivity anytime:

```bash
node server/check-db.js
```

## Deploying

Push to `main` — Vercel builds and deploys automatically (~10 s).
Environment variables (`SHUTTLE_DB_*`, `JWT_SECRET`) live in the Vercel
project settings (Production). Fallback: `npx vercel --prod`.

## Database setup (Supabase)

1. Create a project at [supabase.com](https://supabase.com) (region matters —
   the pooler host is region-specific).
2. SQL Editor → run `server/supabase-schema.sql`, then any files in
   `server/migrations/` (idempotent).
3. **Use the connection pooler**, not the direct host: host
   `aws-0-<region>.pooler.supabase.com`, port `6543`, user
   `postgres.<project-ref>`. The direct host is IPv6-only and times out from
   Vercel.

## Security model

- Passwords hashed with PBKDF2-HMAC-SHA256 (60k iterations, per-row salt);
  legacy plaintext rows upgrade on first login.
- JWT bearer auth, 8-hour expiry; role checks per route.
- Parameterized queries everywhere; 4 KB body limit; async routes wrapped so
  DB errors can't kill the serverless function.
- Staff account passwords are managed in-app by the admin role.

## Project structure

```
index.html                 frontend (vanilla JS SPA, no build step)
api/index.js               serverless entry point for Vercel
server/server.js           Express routes + auth middleware
server/lib/                db pool, crypto, business rules, domain constants
server/check-db.js         DB connectivity checker
server/supabase-schema.sql base schema
server/migrations/         incremental schema migrations
vercel.json                routing config
.vercelignore              deploy upload exclusions
legacy/                    archived C/MySQL implementation (reference only)
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full feature list,
architecture diagrams, data model, and operational gotchas.
See **[ROADMAP.md](ROADMAP.md)** for PRD implementation status, acceptance
criteria, and the phased build order for the dispatch optimizer and
conductor/live-tracking features.
