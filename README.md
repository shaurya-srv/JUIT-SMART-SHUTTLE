# JUIT Smart Shuttle

A C-based smart hostel shuttle request and verification system designed to improve transportation between JUIT Solan's campus and its off-campus hostels.

## Overview

Due to increased hostel occupancy, students may be accommodated in hostels located outside the main campus. This creates a need for an efficient shuttle transportation system that can handle dynamic student pickup requests without unnecessary trips or fuel consumption.

The system allows:
- Students to submit shuttle pickup requests when required.
- Requests to be temporarily stored and passed to the verification system.
- Guards to independently access pending requests.
- Guards to verify student details before approving a request.
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

## Features

- Student registration with roll number, room, hostel, and phone
- Pickup/drop-off request creation across 4 fixed shuttle locations:
  - JUIT Main Gate
  - Ravli PG
  - Peach Tree (Azad Extension)
  - Waknaghat
- Guard portal for request approval/rejection
- Request status tracking for students
- Bus scheduler portal:
  - Register buses with route and max capacity
  - Auto-assign approved requests to buses on matching routes
  - View per-bus schedule with assigned students
  - View route capacity summary (total seats, assigned, available)
  - Unassign requests from buses
- Bus assignment shown in request views and student status
- File-based data persistence

## How to Compile and Run

```bash
gcc index.c -o shuttle
./shuttle
```

## Project Structure

| File | Description |
|------|-------------|
| `index.c` | Main source code |
| `studentregistration.txt` | Registered student records |
| `pendingrequest.txt` | Pending shuttle requests |
| `approvedrequest.txt` | Approved shuttle requests |
| `rejectedrequest.txt` | Rejected shuttle requests |
| `busschedule.txt` | Bus fleet and route assignments |
| `busassignments.txt` | Request-to-bus mapping |
