#ifndef DATABASE_H
#define DATABASE_H

#include <mysql.h>

// Domain types are shared with core/ (models.h defines them).
#include "src/core/models.h"

// Loaders for core/ and CLI list views — fill up to `max` entries,
// return count, or -1 on a database error.
int db_get_buses(bus_t *out, int max);
int db_get_request_routes_by_status(const char *status, request_route_t *out, int max);
int db_get_pending_request_summaries(request_summary_t *out, int max);

// Structured request rows (joined with student info) for list views.
// status NULL = all statuses. Returns count, or -1 on a database error.
int db_get_request_rows_by_status(const char *status, request_row_t *out, int max);
// Requests of one student, newest first. Returns count, or -1 on error.
int db_get_request_rows_by_student(int roll_number, request_row_t *out, int max);
// Current status of one request into `out` (cap >= 35). 1 on success.
int db_get_request_status(int request_number, char *out, size_t outsz);

extern MYSQL *db;

int db_init(const char *host, const char *user, const char *pass, const char *dbname, unsigned int port);
void db_close(void);

// Students
int db_register_student(const char *name, int roll_no, const char *room,
                        const char *hostel, const char *phone, const char *password);
int db_find_student(int roll_no, char *name, char *room, char *hostel, char *phone);
int db_student_exists(int roll_no);
int db_verify_student_password(int roll_no, const char *password);

// Requests
int db_create_request(int roll_no, const char *pickup_place, const char *dropoff_place);
int db_update_request_status(int request_number, const char *new_status);
int db_get_next_request_number(void);
int db_get_requests_by_status(const char *status);
int db_get_student_requests(int roll_no);

// Buses
int db_register_bus(int route_pickup, int route_dropoff, int max_capacity);
int db_update_bus_count(int bus_number, int delta);
int db_count_buses(void);

// Assignments
int db_assign_request_to_bus(int request_number, int bus_number);
int db_is_request_assigned(int request_number);
int db_unassign_request(int request_number);

// Credentials
int db_verify_role_password(const char *role, const char *password);
void db_create_default_credentials(void);

// Migration
void db_migrate_from_text_files(void);

// Health check: 1 if the connection is alive (pings the server), 0 if not.
int db_ping(void);

// Transactions: wrap multi-statement mutations (atomic assignments,
// request-number allocation). 1 on success.
int db_begin(void);
int db_commit(void);
int db_rollback(void);

// Reporting
int db_view_bus_schedule(void);
int db_view_route_capacity(void);

#endif
