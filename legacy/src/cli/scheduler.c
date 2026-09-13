// Bus-scheduler-facing CLI: register buses, trigger assignment, reports.
// All business rules live in core/; all SQL lives in db/ (database.c).

#include <stdio.h>
#include "io.h"
#include "scheduler.h"
#include "src/db/database.h"
#include "src/core/models.h"
#include "src/core/service.h"

void registerBus(void) {
    printf("\nREGISTER NEW BUS\n");

    printf("\nAvailable Locations:\n");
    printf("1. JUIT\n");
    printf("2. Ravli PG\n");
    printf("3. Peach Tree\n");
    printf("4. Waknaghat\n");

    int choice;
    printf("\nEnter route pickup location: ");
    choice = read_int();
    if (choice < 1 || choice > 4) {
        printf("\nInvalid location.\n");
        return;
    }
    int pickup = choice - 1;

    printf("Enter route dropoff location: ");
    choice = read_int();
    if (choice < 1 || choice > 4) {
        printf("\nInvalid location.\n");
        return;
    }
    int dropoff = choice - 1;

    if (pickup == dropoff) {
        printf("\nPickup and dropoff cannot be the same location.\n");
        return;
    }

    printf("Enter bus max capacity (1-30): ");
    int capacity = read_int();
    if (capacity < 1 || capacity > 30) {
        printf("\nInvalid capacity.\n");
        return;
    }

    db_register_bus(pickup, dropoff, capacity);
}

// CLI wrapper: runs the core assignment algorithm and renders its result.
void assignRequests(void) {
    if (db_count_buses() == 0) {
        printf("\nNo buses registered. Please register buses first.\n");
        return;
    }

    core_assign_result_t result;
    if (!core_assign_approved_requests(&result)) {
        printf("\nDatabase error while assigning requests.\n");
        return;
    }

    // Report capacity warnings (80%+) once per bus.
    for (int w = 0; w < result.warned_count; w++) {
        bus_t warned[MAX_BUSES];
        int n = db_get_buses(warned, MAX_BUSES);
        for (int i = 0; i < n; i++) {
            if (warned[i].bus_number == result.warned_bus_numbers[w]) {
                printf("\n[WARNING] Bus %d is at %d/%d capacity (%.0f%%)%s",
                       warned[i].bus_number,
                       warned[i].current_count,
                       warned[i].max_capacity,
                       (double)warned[i].current_count * 100.0 / warned[i].max_capacity,
                       warned[i].current_count == warned[i].max_capacity ? " -- FULL" : "");
            }
        }
    }

    if (result.assigned_count > 0) {
        printf("\n%d request(s) assigned to buses.\n", result.assigned_count);
    } else {
        printf("\nNo new requests could be assigned.\n");
        printf("Possible reasons: no buses on matching routes, or all buses are full.\n");
    }
    if (result.no_bus_available > 0) {
        printf("%d approved request(s) could not be placed.\n", result.no_bus_available);
    }
}

void unassignRequest(void) {
    int req_num;
    printf("\nUNASSIGN REQUEST FROM BUS\n");
    printf("Enter request number to unassign: ");
    req_num = read_int();
    db_unassign_request(req_num);
}

void busSchedulerPortal(void) {
    int choice;
    while (1) {
        printf("\nBUS SCHEDULER PORTAL");
        printf("\n1. Register New Bus");
        printf("\n2. Auto-Assign Approved Requests to Buses");
        printf("\n3. View Bus Schedule");
        printf("\n4. View Route Capacity Summary");
        printf("\n5. Unassign a Request from Bus");
        printf("\n6. Exit Bus Scheduler Portal");
        printf("\n\nEnter your choice: ");

        choice = read_int();

        if (choice == 1) {
            registerBus();
        } else if (choice == 2) {
            assignRequests();
        } else if (choice == 3) {
            db_view_bus_schedule();
        } else if (choice == 4) {
            db_view_route_capacity();
        } else if (choice == 5) {
            unassignRequest();
        } else if (choice == 6) {
            printf("\nExiting Bus Scheduler Portal...\n");
            break;
        } else {
            printf("\nInvalid choice. Try again.\n");
        }
    }
}
