// Entry point + login page. Wires db/ init and dispatches to the CLI portals.

#include <stdio.h>
#include <stdlib.h>
#include "src/db/database.h"
#include "src/core/models.h"
#include "src/cli/io.h"
#include "src/cli/student.h"
#include "src/cli/guard.h"
#include "src/cli/scheduler.h"

static void loginPage(void) {
    db_create_default_credentials();

    int choice;
    while (1) {
        printf("\n========================================");
        printf("\n       JUIT SMART SHUTTLE");
        printf("\n========================================");
        printf("\n");
        printf("\n  1. Student Login");
        printf("\n  2. Guard Login");
        printf("\n  3. Bus Scheduler Login");
        printf("\n  4. Register (New Student)");
        printf("\n  5. Exit");
        printf("\n\nEnter your choice: ");
        choice = read_int();

        if (choice == 1) {
            int roll_number;
            char password[31];
            struct student s;
            int attempts = 0;

            printf("\n--- STUDENT LOGIN ---\n");
            printf("Enter roll number: ");
            roll_number = read_int();

            if (!findstudent(roll_number, &s)) {
                printf("\nStudent not found. Please register first.\n");
                continue;
            }

            while (attempts < 3) {
                printf("Enter password: ");
                read_password(password, sizeof(password));

                if (db_verify_student_password(roll_number, password)) {
                    printf("\nWelcome, %s!\n", s.name);
                    studentportal(&s);
                    break;
                }
                attempts++;
                if (attempts < 3)
                    printf("Incorrect password. %d attempt(s) remaining.\n", 3 - attempts);
            }
            if (attempts == 3)
                printf("\nToo many failed attempts.\n");
        } else if (choice == 2) {
            char password[31];
            int attempts = 0;

            printf("\n--- GUARD LOGIN ---\n");
            while (attempts < 3) {
                printf("Enter password: ");
                read_password(password, sizeof(password));

                if (db_verify_role_password("guard", password)) {
                    printf("\nWelcome!\n");
                    guardmenu();
                    break;
                }
                attempts++;
                if (attempts < 3)
                    printf("Incorrect password. %d attempt(s) remaining.\n", 3 - attempts);
            }
            if (attempts == 3)
                printf("\nToo many failed attempts.\n");
        } else if (choice == 3) {
            char password[31];
            int attempts = 0;

            printf("\n--- BUS SCHEDULER LOGIN ---\n");
            while (attempts < 3) {
                printf("Enter password: ");
                read_password(password, sizeof(password));

                if (db_verify_role_password("scheduler", password)) {
                    printf("\nWelcome!\n");
                    busSchedulerPortal();
                    break;
                }
                attempts++;
                if (attempts < 3)
                    printf("Incorrect password. %d attempt(s) remaining.\n", 3 - attempts);
            }
            if (attempts == 3)
                printf("\nToo many failed attempts.\n");
        } else if (choice == 4) {
            struct student s;
            studentregistration(&s);
        } else if (choice == 5) {
            printf("\nGoodbye!\n");
            break;
        } else {
            printf("\nInvalid choice.\n");
        }
    }
}

int main(void) {
    // Connection settings can be overridden via environment variables:
    //   SHUTTLE_DB_HOST, SHUTTLE_DB_USER, SHUTTLE_DB_PASS, SHUTTLE_DB_NAME, SHUTTLE_DB_PORT
    const char *mysql_host = getenv("SHUTTLE_DB_HOST"); if (!mysql_host) mysql_host = "127.0.0.1";
    const char *mysql_user = getenv("SHUTTLE_DB_USER"); if (!mysql_user) mysql_user = "root";
    const char *mysql_pass = getenv("SHUTTLE_DB_PASS");
    if (!mysql_pass) {
        fprintf(stderr, "\nError: SHUTTLE_DB_PASS environment variable is not set.\n");
        fprintf(stderr, "  Set it before running:  export SHUTTLE_DB_PASS=yourpassword\n\n");
        return 1;
    }
    const char *mysql_db   = getenv("SHUTTLE_DB_NAME"); if (!mysql_db)   mysql_db = "shuttle_db";
    const char *port_str   = getenv("SHUTTLE_DB_PORT");
    unsigned int mysql_port = port_str ? (unsigned int)atoi(port_str) : 3306;

    printf("\n========================================");
    printf("\n  JUIT Smart Shuttle - Database Setup");
    printf("\n========================================\n");

    if (!db_init(mysql_host, mysql_user, mysql_pass, mysql_db, mysql_port)) {
        fprintf(stderr, "\nFailed to connect to MySQL. Exiting.\n");
        return 1;
    }

    // CLI is single-threaded: pool of 1 is enough.
    db_pool_init(1);
    db_pool_acquire();       // sets TLS so db_conn() works

    db_migrate_from_text_files();
    loginPage();

    db_pool_release();
    db_pool_shutdown();
    db_close();
    return 0;
}
