#ifndef TESTS_STUB_DB_H
#define TESTS_STUB_DB_H

// In-memory fake of the db layer, used by the test runner in place of
// database.c. Lets the core assignment algorithm be tested without a
// MySQL server.

#include <stddef.h>
#include "src/core/models.h"

// Declarations of the db_* functions stubbed here (normally in
// src/db/database.h, which requires MySQL headers — not wanted in tests).
// Signatures mirror the real layer exactly.
int db_get_buses(bus_t *out, int max);
int db_get_request_routes_by_status(const char *status, request_route_t *out, int max);
int db_is_request_assigned(int request_number);
int db_assign_request_to_bus(int request_number, int bus_number);
int db_update_request_status(int request_number, const char *new_status);
int db_get_request_status(int request_number, char *out, size_t outsz);

// Reset all stub state to empty (no buses, no requests, no fail flags).
void stub_reset(void);

// Add a bus / an approved request to the fake data.
// Returns index of the stored entry, or -1 if full.
int stub_add_bus(int bus_number, int route_pickup, int route_dropoff,
                 int current_count, int max_capacity);
int stub_add_request(int request_number, int pickup_location, int dropoff_location);

// Make db_assign_request_to_bus() fail (exercises the db-error path in core).
void stub_fail_next_assign(void);

#endif // TESTS_STUB_DB_H
