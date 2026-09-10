// Student-facing CLI: registration, portal, request creation, status view.
// All business rules live in core/; all SQL lives in db/ (database.c).

#include <stdio.h>
#include <string.h>
#include "io.h"
#include "student.h"
#include "src/db/database.h"
#include "src/core/models.h"
#include "src/core/service.h"

void studentregistration(struct student *s) {
    printf("\nSTUDENT REGISTRATION\n");
    printf("Enter your roll number: ");
    s->student_roll_no = read_int();
    if (db_student_exists(s->student_roll_no)) {
        printf("\nA student with roll number %d is already registered.\n", s->student_roll_no);
        printf("Registration cancelled.\n");
        return;
    }
    printf("Enter your name: ");
    scanf(" %[^\n]", s->name);
    printf("Enter your Room Number: ");
    scanf(" %[^\n]", s->room_number);
    printf("Enter your hostel name: ");
    scanf(" %[^\n]", s->hostel_name);
    printf("Enter your phone number: ");
    scanf(" %[^\n]", s->phone_number);

    printf("Enter a password: ");
    read_password(s->password, sizeof(s->password));
    if (s->password[0] == '\0') {
        printf("\nPassword cannot be empty. Registration cancelled.\n");
        return;
    }

    db_register_student(s->name, s->student_roll_no, s->room_number,
                        s->hostel_name, s->phone_number, s->password);
}

int findstudent(int roll_number, struct student *s) {
    if (db_find_student(roll_number, s->name, s->room_number,
                        s->hostel_name, s->phone_number)) {
        s->student_roll_no = roll_number;
        return 1;
    }
    printf("\nStudent with roll number %d not found.\n", roll_number);
    return 0;
}

void createAndSaveRequest(struct student *s) {
    struct pickuprequest request;

    printf("\nCREATE PICKUP REQUEST\n");
    printf("Logged in as: %s (Roll: %d)\n", s->name, s->student_roll_no);

    printf("\nAvailable locations:\n");
    printf("1. JUIT\n");
    printf("2. Ravli PG\n");
    printf("3. Peach Tree\n");
    printf("4. Waknaghat\n");

    printf("\nEnter pickup place: ");
    scanf(" %[^\n]", request.pickup_place);

    printf("Enter dropoff place: ");
    scanf(" %[^\n]", request.dropoff_place);

    int result = db_create_request(s->student_roll_no,
                                   request.pickup_place,
                                   request.dropoff_place);
    if (result > 0) {
        // Request created successfully
    }
}

void studentrequeststatus(int roll_number) {
    printf("\nCHECK REQUEST STATUS\n");
    printf("\n--- Your Requests ---\n");
    int count = db_get_student_requests(roll_number);
    if (count == 0) {
        printf("\nNo requests found for Roll Number %d.\n", roll_number);
    }
}

void studentportal(struct student *current_student) {
    int choice;
    while (1) {
        printf("\nSTUDENT PORTAL");
        printf("\nLogged in as: %s (Roll: %d)", current_student->name, current_student->student_roll_no);
        printf("\n1. Create Pickup Request");
        printf("\n2. Check Request Status");
        printf("\n3. Exit Student Portal");
        printf("\nEnter your choice: ");
        choice = read_int();
        if (choice == 1) {
            createAndSaveRequest(current_student);
        } else if (choice == 2) {
            studentrequeststatus(current_student->student_roll_no);
        } else if (choice == 3) {
            printf("\nExiting Student Portal...\n");
            break;
        } else {
            printf("\nInvalid choice. Try again.\n");
        }
    }
}
