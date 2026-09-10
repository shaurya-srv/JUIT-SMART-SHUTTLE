#include <string.h>
#include "service.h"
#include "src/db/database.h"

// The single copy of the business rules. Pure computation + orchestration
// of db/ calls. No printf, no menus, no console input here.

// Cap on how many approved requests one assignment run processes.
// (Bounded for stack safety; a run can be repeated if more accumulate.)
#define CORE_MAX_REQUESTS 512

// ------------------------------------------------------------
// Location rules
// ------------------------------------------------------------

int core_location_from_name(const char *location_name) {
    if (location_name == NULL) return -1;
    if (strcmp(location_name, "JUIT") == 0)       return LOC_JUIT;
    if (strcmp(location_name, "Ravli PG") == 0)   return LOC_RAVLI;
    if (strcmp(location_name, "Peach Tree") == 0) return LOC_PEACH_TREE;
    if (strcmp(location_name, "Waknaghat") == 0)  return LOC_WAKNAGHAT;
    return -1;
}

int core_direction(int pickup_location, int dropoff_location) {
    if (pickup_location < dropoff_location) return 1;
    if (pickup_location > dropoff_location) return -1;
    return 0;
}

int core_route_is_valid(int pickup_location, int dropoff_location) {
    if (pickup_location < 0 || pickup_location >= LOC_COUNT) return 0;
    if (dropoff_location < 0 || dropoff_location >= LOC_COUNT) return 0;
    return pickup_location != dropoff_location;
}

// ------------------------------------------------------------
// Request lifecycle transitions
// ------------------------------------------------------------

int core_approve_request(int request_number) {
    return db_update_request_status(request_number, "APPROVED");
}

int core_reject_request(int request_number) {
    return db_update_request_status(request_number, "REJECTED");
}

// ------------------------------------------------------------
// Bus assignment algorithm
// ------------------------------------------------------------

int core_assign_approved_requests(core_assign_result_t *result) {
    if (result) memset(result, 0, sizeof(*result));

    bus_t buses[MAX_BUSES];
    int bus_count = db_get_buses(buses, MAX_BUSES);
    if (bus_count < 0) return 0;               // database error

    request_route_t reqs[CORE_MAX_REQUESTS];
    int req_count = db_get_request_routes_by_status("APPROVED", reqs, CORE_MAX_REQUESTS);
    if (req_count < 0) return 0;               // database error

    int assigned = 0;

    for (int r = 0; r < req_count; r++) {
        int req_num = reqs[r].request_number;

        if (db_is_request_assigned(req_num)) {
            if (result) result->skipped_already_assigned++;
            continue;
        }

        int placed = 0;
        for (int i = 0; i < bus_count; i++) {
            if (buses[i].route_pickup == reqs[r].pickup_location &&
                buses[i].route_dropoff == reqs[r].dropoff_location &&
                buses[i].current_count < buses[i].max_capacity) {

                if (!db_assign_request_to_bus(req_num, buses[i].bus_number))
                    break;                     // db error; leave request unassigned

                buses[i].current_count++;
                placed = 1;
                assigned++;
                if (result) result->assigned_count = assigned;

                // 80% capacity warning, once per bus per run
                if (result && buses[i].max_capacity > 0 &&
                    buses[i].current_count * 100 / buses[i].max_capacity >= 80) {
                    int already_warned = 0;
                    for (int w = 0; w < result->warned_count; w++) {
                        if (result->warned_bus_numbers[w] == buses[i].bus_number) {
                            already_warned = 1;
                            break;
                        }
                    }
                    if (!already_warned && result->warned_count < MAX_BUSES) {
                        result->warned_bus_numbers[result->warned_count++] = buses[i].bus_number;
                    }
                }
                break;
            }
        }

        if (!placed && result) result->no_bus_available++;
    }

    return 1;
}
