// In-memory implementation of the db functions that
// core_assign_approved_requests() uses. Mirrors the real layer's contract:
// loaders return -1 on "error" (not exercised here), assign returns 0/1.

#include <stdio.h>
#include <string.h>
#include "stub_db.h"
#include "src/db/database.h"

static bus_t            s_buses[MAX_BUSES];
static int              s_bus_count;
static request_route_t  s_requests[512];
static int              s_request_count;
static int              s_assigned[512];  // parallel to s_requests: bus# or 0
static char             s_status[512][40]; // parallel: lifecycle status
static int              s_fail_next_assign;

void stub_reset(void) {
    s_bus_count = 0;
    s_request_count = 0;
    s_fail_next_assign = 0;
    memset(s_buses, 0, sizeof(s_buses));
    memset(s_requests, 0, sizeof(s_requests));
    memset(s_assigned, 0, sizeof(s_assigned));
    memset(s_status, 0, sizeof(s_status));
}

int stub_add_bus(int bus_number, int route_pickup, int route_dropoff,
                 int current_count, int max_capacity) {
    if (s_bus_count >= MAX_BUSES) return -1;
    s_buses[s_bus_count].bus_number    = bus_number;
    s_buses[s_bus_count].route_pickup  = route_pickup;
    s_buses[s_bus_count].route_dropoff = route_dropoff;
    s_buses[s_bus_count].current_count = current_count;
    s_buses[s_bus_count].max_capacity  = max_capacity;
    return s_bus_count++;
}

int stub_add_request(int request_number, int pickup_location, int dropoff_location) {
    if (s_request_count >= 512) return -1;
    s_requests[s_request_count].request_number  = request_number;
    s_requests[s_request_count].pickup_location = pickup_location;
    s_requests[s_request_count].dropoff_location = dropoff_location;
    s_assigned[s_request_count] = 0;
    snprintf(s_status[s_request_count], sizeof(s_status[0]), "PENDING_APPROVAL");
    return s_request_count++;
}

int stub_set_request_status(int request_number, const char *status) {
    for (int i = 0; i < s_request_count; i++) {
        if (s_requests[i].request_number == request_number) {
            snprintf(s_status[i], sizeof(s_status[0]), "%s", status);
            return 1;
        }
    }
    return 0;
}

void stub_fail_next_assign(void) {
    s_fail_next_assign = 1;
}

int db_get_buses(bus_t *out, int max) {
    if (out == NULL || max <= 0) return 0;
    int n = (s_bus_count < max) ? s_bus_count : max;
    memcpy(out, s_buses, (size_t)n * sizeof(bus_t));
    return n;
}

int db_get_request_routes_by_status(const char *status, request_route_t *out, int max) {
    (void)status; // stub only serves the APPROVED list
    if (out == NULL || max <= 0) return 0;
    int n = (s_request_count < max) ? s_request_count : max;
    memcpy(out, s_requests, (size_t)n * sizeof(request_route_t));
    return n;
}

int db_is_request_assigned(int request_number) {
    for (int i = 0; i < s_request_count; i++) {
        if (s_requests[i].request_number == request_number)
            return s_assigned[i] != 0;
    }
    return 0;
}

int db_update_request_status(int request_number, const char *new_status) {
    for (int i = 0; i < s_request_count; i++) {
        if (s_requests[i].request_number == request_number) {
            snprintf(s_status[i], sizeof(s_status[0]), "%s", new_status);
            return 1;
        }
    }
    return 0;
}

int db_get_request_status(int request_number, char *out, size_t outsz) {
    if (out == NULL || outsz == 0) return 0;
    out[0] = '\0';
    for (int i = 0; i < s_request_count; i++) {
        if (s_requests[i].request_number == request_number) {
            snprintf(out, outsz, "%s", s_status[i]);
            return 1;
        }
    }
    return 0;
}

// Transactions: no-ops — the stub has no concurrency to guard.
int db_begin(void)    { return 1; }
int db_commit(void)   { return 1; }
int db_rollback(void) { return 1; }

int db_assign_request_to_bus(int request_number, int bus_number) {
    if (s_fail_next_assign) {
        s_fail_next_assign = 0;
        return 0;
    }
    for (int i = 0; i < s_request_count; i++) {
        if (s_requests[i].request_number == request_number) {
            s_assigned[i] = bus_number;
            for (int b = 0; b < s_bus_count; b++) {
                if (s_buses[b].bus_number == bus_number) {
                    s_buses[b].current_count++;
                    break;
                }
            }
            return 1;
        }
    }
    return 0;
}
