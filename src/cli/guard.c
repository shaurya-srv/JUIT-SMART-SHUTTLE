// Guard-facing CLI: process pending requests, view approved/rejected.
// All business rules live in core/; all SQL lives in db/ (database.c).

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "io.h"
#include "guard.h"
#include "src/db/database.h"
#include "src/core/models.h"
#include "src/core/service.h"

void guardportal(void) {
    printf("\nGUARD PORTAL - Process Pending Requests\n");

    request_summary_t pending[512];

    int count = db_get_pending_request_summaries(pending, 512);
    if (count < 0) {
        printf("\nError reading pending requests.\n");
        return;
    }
    if (count == 0) {
        printf("\nNo pending requests.\n");
        return;
    }

    int processed = 0;
    for (int i = 0; i < count; i++) {
        int req_num = pending[i].request_number;
        int roll = pending[i].student_roll_number;
        const char *pickup = pending[i].pickup_place;
        const char *dropoff = pending[i].dropoff_place;

        if (roll == 0) {
            printf("\nInvalid student roll number in request %d.\n", req_num);
            continue;
        }

        char name[35], room[60], hostel[30], phone[15];
        if (!db_find_student(roll, name, room, hostel, phone)) {
            printf("\nStudent with roll number %d not found.\n", roll);
            continue;
        }

        printf("\nGUARD PORTAL\n");
        printf("\nStudent Name: %s", name);
        printf("\nRoll Number: %d", roll);
        printf("\nHostel: %s", hostel);
        printf("\nRoom Number: %s", room);
        printf("\nPhone Number: %s", phone);
        printf("\n\nPickup Place: %s", pickup);
        printf("\nDropoff Place: %s", dropoff);
        printf("\nRequest Status: PENDING_APPROVAL\n");

        int guard_choice;
        printf("\n1. Approve Request");
        printf("\n2. Reject Request");
        printf("\nEnter your choice: ");
        guard_choice = read_int();

        if (guard_choice == 1) {
            if (core_approve_request(req_num)) {
                printf("\nYour Request has been APPROVED.\n");
                processed++;
            } else {
                printf("\nCould not approve (already processed or database error).\n");
            }
        } else if (guard_choice == 2) {
            if (core_reject_request(req_num)) {
                printf("\nRequest has been REJECTED.\n");
                processed++;
            } else {
                printf("\nCould not reject (already processed or database error).\n");
            }
        } else {
            printf("\nInvalid choice. Request will remain pending.\n");
        }
    }

    if (processed > 0) {
        printf("\n%d request(s) processed.\n", processed);
    } else {
        printf("\nNo pending requests to process.\n");
    }
}

void guardmenu(void) {
    int choice;
    while (1) {
        printf("\nGUARD PORTAL");
        printf("\n1. Process Pending Requests");
        printf("\n2. View Approved Requests");
        printf("\n3. View Rejected Requests");
        printf("\n4. Exit Guard Portal");
        printf("\nEnter your choice: ");

        choice = read_int();

        if (choice == 1) {
            guardportal();
        } else if (choice == 2) {
            printf("\n===== APPROVED REQUESTS =====\n");
            db_get_requests_by_status("APPROVED");
        } else if (choice == 3) {
            printf("\n===== REJECTED REQUESTS =====\n");
            db_get_requests_by_status("REJECTED");
        } else if (choice == 4) {
            printf("\nExiting Guard Portal...\n");
            break;
        } else {
            printf("\nInvalid choice. Try again.\n");
        }
    }
}
