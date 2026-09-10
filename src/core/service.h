#ifndef CORE_SERVICE_H
#define CORE_SERVICE_H

// core/service — the single copy of the business rules.
// Pure computation + orchestration of db/ calls. No printf, no menus,
// no console input. Clients (CLI today, HTTP API later) render results.

#include "models.h"

// ------------------------------------------------------------
// Location rules
// ------------------------------------------------------------

// Returns LOC_* constant or -1 if the name is unknown.
int core_location_from_name(const char *location_name);

// Returns 1 if moving pickup -> dropoff is "forward" along the route
// (increasing LOC_ order), -1 if backward, 0 if same point.
int core_direction(int pickup_location, int dropoff_location);

// Returns 1 if the pickup/dropoff pair is a valid request route
// (both known and distinct).
int core_route_is_valid(int pickup_location, int dropoff_location);

// ------------------------------------------------------------
// Request lifecycle transitions
// ------------------------------------------------------------

// Approve a request: validates current status, updates the DB.
// Returns 1 on success, 0 on failure (reason printed by caller on request).
int core_approve_request(int request_number);

// Reject a request. Same contract as core_approve_request.
int core_reject_request(int request_number);

// ------------------------------------------------------------
// Bus assignment algorithm
// ------------------------------------------------------------

// Result of one assignment run, for callers to report.
typedef struct {
    int assigned_count;               // requests newly assigned this run
    int skipped_not_approved;         // (reserved) rows skipped: not approved
    int skipped_already_assigned;     // rows skipped: already on a bus
    int no_bus_available;             // approved+unassigned requests with no fitting bus

    int warned_bus_numbers[MAX_BUSES]; // buses that crossed the 80% threshold this run
    int warned_count;
} core_assign_result_t;

// Run the assignment algorithm: for every APPROVED, unassigned request,
// find the first registered bus on the exact matching route with a free
// seat, insert the assignment, and bump that bus's load.
// Returns 0 on a database error that aborted the run, 1 otherwise
// (check result->assigned_count for outcome).
int core_assign_approved_requests(core_assign_result_t *result);

#endif // CORE_SERVICE_H
