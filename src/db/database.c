#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "src/db/database.h"
#include "src/core/crypto.h"
#include "src/core/service.h"

MYSQL *db = NULL;

// Escape a user-supplied string for safe inclusion in a single-quoted SQL literal.
// Returns the escaped length, or 0 if input is empty/invalid.
static unsigned long db_escape(const char *in, char *out, size_t outsz) {
    if (in == NULL || out == NULL || outsz == 0) return 0;
    if (in[0] == '\0') { out[0] = '\0'; return 0; }
    return mysql_real_escape_string(db, out, in, (unsigned long)strlen(in));
}

// ============================================================
// INIT
// ============================================================

int db_init(const char *host, const char *user, const char *pass, const char *dbname, unsigned int port) {
    db = mysql_init(NULL);
    if (db == NULL) { fprintf(stderr, "mysql_init() failed\n"); return 0; }

    if (mysql_real_connect(db, host, user, pass, dbname, port, NULL, 0) == NULL) {
        fprintf(stderr, "Connection failed: %s\n", mysql_error(db));
        mysql_close(db); db = NULL; return 0;
    }
    printf("\n[INFO] Connected to MySQL '%s' at %s:%u\n", dbname, host, port);

    // Create tables
    mysql_query(db,
        "CREATE TABLE IF NOT EXISTS students ("
        "  id INT AUTO_INCREMENT PRIMARY KEY,"
        "  name VARCHAR(35) NOT NULL, roll_number INT UNIQUE NOT NULL,"
        "  room_number VARCHAR(60) NOT NULL, hostel_name VARCHAR(30) NOT NULL,"
        "  phone_number VARCHAR(15) NOT NULL, password VARCHAR(160) NOT NULL,"
        "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        ") ENGINE=InnoDB");

    mysql_query(db,
        "CREATE TABLE IF NOT EXISTS credentials ("
        "  id INT AUTO_INCREMENT PRIMARY KEY,"
        "  role VARCHAR(32) UNIQUE NOT NULL, password VARCHAR(160) NOT NULL"
        ") ENGINE=InnoDB");

    mysql_query(db,
        "CREATE TABLE IF NOT EXISTS pickup_requests ("
        "  id INT AUTO_INCREMENT PRIMARY KEY,"
        "  request_number INT UNIQUE NOT NULL,"
        "  student_roll_number INT NOT NULL,"
        "  pickup_place VARCHAR(31) NOT NULL, dropoff_place VARCHAR(31) NOT NULL,"
        "  pickup_location INT NOT NULL, dropoff_location INT NOT NULL,"
        "  direction INT NOT NULL,"
        "  status VARCHAR(35) NOT NULL DEFAULT 'PENDING_APPROVAL',"
        "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
        "  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
        "  FOREIGN KEY (student_roll_number) REFERENCES students(roll_number)"
        ") ENGINE=InnoDB");

    mysql_query(db,
        "CREATE TABLE IF NOT EXISTS buses ("
        "  id INT AUTO_INCREMENT PRIMARY KEY,"
        "  bus_number INT UNIQUE NOT NULL,"
        "  route_pickup INT NOT NULL, route_dropoff INT NOT NULL,"
        "  current_count INT NOT NULL DEFAULT 0,"
        "  max_capacity INT NOT NULL"
        ") ENGINE=InnoDB");

    mysql_query(db,
        "CREATE TABLE IF NOT EXISTS bus_assignments ("
        "  id INT AUTO_INCREMENT PRIMARY KEY,"
        "  request_number INT UNIQUE NOT NULL,"
        "  bus_number INT NOT NULL,"
        "  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
        "  FOREIGN KEY (request_number) REFERENCES pickup_requests(request_number),"
        "  FOREIGN KEY (bus_number) REFERENCES buses(bus_number)"
        ") ENGINE=InnoDB");

    mysql_query(db, "CREATE INDEX idx_requests_status ON pickup_requests(status)");
    mysql_query(db, "CREATE INDEX idx_requests_student ON pickup_requests(student_roll_number)");
    mysql_query(db, "CREATE INDEX idx_buses_route ON buses(route_pickup, route_dropoff)");

    // Widen legacy password columns (VARCHAR(31)/32) so hashed passwords fit.
    // Errors are ignored on fresh databases where the column is already 160.
    mysql_query(db, "ALTER TABLE students MODIFY password VARCHAR(160) NOT NULL");
    mysql_query(db, "ALTER TABLE credentials MODIFY password VARCHAR(160) NOT NULL");

    printf("[INFO] Database schema ready.\n");
    return 1;
}

void db_close(void) { if (db) { mysql_close(db); db = NULL; } }

int db_ping(void) {
    return (db != NULL && mysql_ping(db) == 0) ? 1 : 0;
}

// ------------------------------------------------------------
// TRANSACTIONS — wrap multi-statement mutations so they succeed
// or fail as one unit (atomic assignments, request numbers).
// ------------------------------------------------------------

int db_begin(void)    { return mysql_query(db, "START TRANSACTION") == 0; }
int db_commit(void)   { return mysql_query(db, "COMMIT") == 0; }
int db_rollback(void) { mysql_query(db, "ROLLBACK"); return 1; }

// ============================================================
// STUDENTS
// ============================================================

int db_register_student(const char *name, int roll_no, const char *room,
                        const char *hostel, const char *phone, const char *password) {
    if (db_student_exists(roll_no)) {
        printf("\nStudent with roll %d already registered.\n", roll_no); return 0;
    }
    // Salted PBKDF2 hash — plaintext is never stored.
    char hashed[PW_HASH_STORAGE_LEN];
    if (!pw_hash(password, hashed, sizeof(hashed))) return 0;

    char ename[80], eroom[130], ehostel[70], ephone[40], epass[256]; char q[1400];
    db_escape(name, ename, sizeof(ename));
    db_escape(room, eroom, sizeof(eroom));
    db_escape(hostel, ehostel, sizeof(ehostel));
    db_escape(phone, ephone, sizeof(ephone));
    db_escape(hashed, epass, sizeof(epass));
    snprintf(q, sizeof(q),
        "INSERT INTO students (name,roll_number,room_number,hostel_name,phone_number,password) "
        "VALUES ('%s',%d,'%s','%s','%s','%s')", ename, roll_no, eroom, ehostel, ephone, epass);
    if (mysql_query(db, q) != 0) { fprintf(stderr, "Register failed: %s\n", mysql_error(db)); return 0; }
    printf("\nStudent registration successful!\n");
    return 1;
}

int db_find_student(int roll_no, char *name, char *room, char *hostel, char *phone) {
    char q[256];
    snprintf(q, sizeof(q), "SELECT name,room_number,hostel_name,phone_number FROM students WHERE roll_number=%d", roll_no);
    if (mysql_query(db, q) != 0) return 0;
    MYSQL_RES *r = mysql_store_result(db); if (!r) return 0;
    MYSQL_ROW row = mysql_fetch_row(r); int found = 0;
    if (row) {
        if (name) strcpy(name, row[0]?row[0]:"");
        if (room) strcpy(room, row[1]?row[1]:"");
        if (hostel) strcpy(hostel, row[2]?row[2]:"");
        if (phone) strcpy(phone, row[3]?row[3]:"");
        found = 1;
    }
    mysql_free_result(r); return found;
}

int db_student_exists(int roll_no) {
    char q[256];
    snprintf(q, sizeof(q), "SELECT COUNT(*) FROM students WHERE roll_number=%d", roll_no);
    if (mysql_query(db, q) != 0) return 0;
    MYSQL_RES *r = mysql_store_result(db); if (!r) return 0;
    MYSQL_ROW row = mysql_fetch_row(r);
    int c = (row&&row[0]) ? atoi(row[0]) : 0;
    mysql_free_result(r); return c > 0;
}

int db_verify_student_password(int roll_no, const char *password) {
    if (!password) return 0;
    char q[256];
    snprintf(q, sizeof(q), "SELECT password FROM students WHERE roll_number=%d", roll_no);
    if (mysql_query(db, q) != 0) return 0;
    MYSQL_RES *r = mysql_store_result(db); if (!r) return 0;
    MYSQL_ROW row = mysql_fetch_row(r);
    int ok = 0;
    if (row && row[0]) {
        ok = pw_verify(password, row[0]);
        // Legacy plaintext: re-hash on first successful login.
        if (ok && strncmp(row[0], "pbkdf2-sha256$", 14) != 0) {
            char hashed[PW_HASH_STORAGE_LEN];
            char ehashed[256];
            if (pw_hash(password, hashed, sizeof(hashed)) &&
                db_escape(hashed, ehashed, sizeof(ehashed)) > 0) {
                char uq[512];
                snprintf(uq, sizeof(uq), "UPDATE students SET password='%s' WHERE roll_number=%d",
                         ehashed, roll_no);
                mysql_query(db, uq);
            }
        }
    }
    mysql_free_result(r); return ok;
}

// ============================================================
// REQUESTS
// ============================================================

int db_create_request(int roll_no, const char *pickup_place, const char *dropoff_place) {
    int p = core_location_from_name(pickup_place);
    int d = core_location_from_name(dropoff_place);
    if (p == -1 || d == -1) { printf("\nInvalid location.\n"); return 0; }
    if (p == d) { printf("\nPickup and dropoff cannot be the same.\n"); return 0; }

    // Allocate the request number inside a transaction so two concurrent
    // creates can never pick the same MAX()+1 value.
    if (!db_begin()) return 0;
    int rn = db_get_next_request_number();
    int dir = (p < d) ? 1 : -1;
    char ep[80], ed[80]; char q[640];
    db_escape(pickup_place, ep, sizeof(ep));
    db_escape(dropoff_place, ed, sizeof(ed));
    snprintf(q, sizeof(q),
        "INSERT INTO pickup_requests (request_number,student_roll_number,pickup_place,dropoff_place,"
        "pickup_location,dropoff_location,direction,status) VALUES (%d,%d,'%s','%s',%d,%d,%d,'PENDING_APPROVAL')",
        rn, roll_no, ep, ed, p, d, dir);
    if (mysql_query(db, q) != 0) {
        fprintf(stderr, "Create request failed: %s\n", mysql_error(db));
        db_rollback(); return 0;
    }
    if (!db_commit()) { db_rollback(); return 0; }
    printf("\nPickup request created! Request #%d\n", rn);
    return rn;
}

int db_update_request_status(int request_number, const char *new_status) {
    if (new_status == NULL) return 0;
    // status values are program constants, but escape defensively anyway
    char es[80]; char q[256];
    db_escape(new_status, es, sizeof(es));
    snprintf(q, sizeof(q), "UPDATE pickup_requests SET status='%s' WHERE request_number=%d", es, request_number);
    if (mysql_query(db,q)!=0) { fprintf(stderr,"Update failed: %s\n",mysql_error(db)); return 0; }
    return mysql_affected_rows(db) > 0 ? 1 : 0;
}

int db_get_next_request_number(void) {
    if (mysql_query(db, "SELECT COALESCE(MAX(request_number),0)+1 FROM pickup_requests")!=0) return 1;
    MYSQL_RES *r = mysql_store_result(db); if (!r) return 1;
    MYSQL_ROW row = mysql_fetch_row(r);
    int n = (row&&row[0]) ? atoi(row[0]) : 1;
    mysql_free_result(r); return n;
}

int db_get_requests_by_status(const char *status) {
    char es[80]; char q[512];
    db_escape(status ? status : "", es, sizeof(es));
    snprintf(q, sizeof(q),
        "SELECT r.request_number,s.name,s.roll_number,s.hostel_name,s.room_number,"
        "s.phone_number,r.pickup_place,r.dropoff_place,r.status "
        "FROM pickup_requests r JOIN students s ON r.student_roll_number=s.roll_number "
        "WHERE r.status='%s' ORDER BY r.request_number", es);
    if (mysql_query(db,q)!=0) { fprintf(stderr,"Query error: %s\n",mysql_error(db)); return 0; }
    MYSQL_RES *r = mysql_store_result(db); if (!r) return 0;
    int count=0; MYSQL_ROW row;
    while ((row=mysql_fetch_row(r))) {
        int rn=atoi(row[0]); const char *nm=row[1]?row[1]:""; int roll=atoi(row[2]);
        const char *hos=row[3]?row[3]:""; const char *rm=row[4]?row[4]:""; const char *ph=row[5]?row[5]:"";
        const char *pk=row[6]?row[6]:""; const char *dp=row[7]?row[7]:"";

        int bn=0; char aq[256];
        snprintf(aq,sizeof(aq),"SELECT bus_number FROM bus_assignments WHERE request_number=%d",rn);
        if (mysql_query(db,aq)==0) { MYSQL_RES *ar=mysql_store_result(db); if(ar){MYSQL_ROW ar2=mysql_fetch_row(ar); if(ar2)bn=atoi(ar2[0]); mysql_free_result(ar);} }

        printf("\n  [%d] %s (Roll: %d)", rn, nm, roll);
        printf("\n  Hostel: %s | Room: %s | Phone: %s", hos, rm, ph);
        printf("\n  %s -> %s", pk, dp);
        if (bn>0) printf("\n  Bus: %d", bn);
        printf("\n"); count++;
    }
    mysql_free_result(r); return count;
}

int db_get_student_requests(int roll_no) {
    char q[512];
    snprintf(q, sizeof(q),
        "SELECT request_number,pickup_place,dropoff_place,status "
        "FROM pickup_requests WHERE student_roll_number=%d ORDER BY request_number DESC", roll_no);
    if (mysql_query(db,q)!=0) return 0;
    MYSQL_RES *r = mysql_store_result(db); if (!r) return 0;
    int count=0; MYSQL_ROW row;
    while ((row=mysql_fetch_row(r))) {
        int rn=atoi(row[0]); const char *pk=row[1]?row[1]:""; const char *dp=row[2]?row[2]:""; const char *st=row[3]?row[3]:"";
        int bn=0; char aq[256];
        snprintf(aq,sizeof(aq),"SELECT bus_number FROM bus_assignments WHERE request_number=%d",rn);
        if (mysql_query(db,aq)==0) { MYSQL_RES *ar=mysql_store_result(db); if(ar){MYSQL_ROW ar2=mysql_fetch_row(ar); if(ar2)bn=atoi(ar2[0]); mysql_free_result(ar);} }
        printf("\n  [%d] %s -> %s | Status: %s", rn, pk, dp, st);
        if (bn>0) printf(" | Bus: %d", bn);
        count++;
    }
    mysql_free_result(r); return count;
}

// ============================================================
// BUSES
// ============================================================

// Loaders for core/ — fill up to max entries, return count, or -1 on db error.
int db_get_buses(bus_t *out, int max) {
    if (out == NULL || max <= 0) return 0;
    if (mysql_query(db, "SELECT bus_number,route_pickup,route_dropoff,current_count,max_capacity "
                         "FROM buses ORDER BY bus_number") != 0) return -1;
    MYSQL_RES *res = mysql_store_result(db);
    if (!res) return -1;
    int n = 0;
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(res)) != NULL && n < max) {
        out[n].bus_number    = atoi(row[0] ? row[0] : "0");
        out[n].route_pickup  = atoi(row[1] ? row[1] : "0");
        out[n].route_dropoff = atoi(row[2] ? row[2] : "0");
        out[n].current_count = atoi(row[3] ? row[3] : "0");
        out[n].max_capacity  = atoi(row[4] ? row[4] : "0");
        n++;
    }
    mysql_free_result(res);
    return n;
}

int db_get_request_routes_by_status(const char *status, request_route_t *out, int max) {
    if (out == NULL || max <= 0 || status == NULL) return 0;
    // status values are program constants, but escape defensively anyway
    char es[80]; char q[256];
    db_escape(status, es, sizeof(es));
    snprintf(q, sizeof(q),
        "SELECT request_number,pickup_location,dropoff_location FROM pickup_requests "
        "WHERE status='%s' ORDER BY request_number", es);
    if (mysql_query(db, q) != 0) return -1;
    MYSQL_RES *res = mysql_store_result(db);
    if (!res) return -1;
    int n = 0;
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(res)) != NULL && n < max) {
        out[n].request_number  = atoi(row[0] ? row[0] : "0");
        out[n].pickup_location  = atoi(row[1] ? row[1] : "0");
        out[n].dropoff_location = atoi(row[2] ? row[2] : "0");
        n++;
    }
    mysql_free_result(res);
    return n;
}

int db_get_pending_request_summaries(request_summary_t *out, int max) {
    if (out == NULL || max <= 0) return 0;
    if (mysql_query(db, "SELECT request_number,student_roll_number,pickup_place,dropoff_place "
                         "FROM pickup_requests WHERE status='PENDING_APPROVAL' ORDER BY request_number") != 0)
        return -1;
    MYSQL_RES *res = mysql_store_result(db);
    if (!res) return -1;
    int n = 0;
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(res)) != NULL && n < max) {
        out[n].request_number      = atoi(row[0] ? row[0] : "0");
        out[n].student_roll_number = atoi(row[1] ? row[1] : "0");
        snprintf(out[n].pickup_place,  sizeof(out[n].pickup_place),  "%s", row[2] ? row[2] : "");
        snprintf(out[n].dropoff_place, sizeof(out[n].dropoff_place), "%s", row[3] ? row[3] : "");
        n++;
    }
    mysql_free_result(res);
    return n;
}

// Fill one request_row_t from a joined SELECT row.
// Column order: req#, name, roll, hostel, room, phone, pickup, dropoff, status
static void fill_request_row(request_row_t *r, MYSQL_ROW row) {
    r->request_number       = atoi(row[0] ? row[0] : "0");
    snprintf(r->student_name,    sizeof(r->student_name),    "%s", row[1] ? row[1] : "");
    r->student_roll_number  = atoi(row[2] ? row[2] : "0");
    snprintf(r->hostel_name,     sizeof(r->hostel_name),     "%s", row[3] ? row[3] : "");
    snprintf(r->room_number,     sizeof(r->room_number),     "%s", row[4] ? row[4] : "");
    snprintf(r->phone_number,    sizeof(r->phone_number),    "%s", row[5] ? row[5] : "");
    snprintf(r->pickup_place,    sizeof(r->pickup_place),    "%s", row[6] ? row[6] : "");
    snprintf(r->dropoff_place,   sizeof(r->dropoff_place),   "%s", row[7] ? row[7] : "");
    snprintf(r->status,          sizeof(r->status),          "%s", row[8] ? row[8] : "");
    r->bus_number = 0;
}

#define REQUEST_ROWS_SELECT \
    "SELECT r.request_number,s.name,s.roll_number,s.hostel_name,s.room_number," \
    "s.phone_number,r.pickup_place,r.dropoff_place,r.status " \
    "FROM pickup_requests r JOIN students s ON r.student_roll_number=s.roll_number "

int db_get_request_rows_by_status(const char *status, request_row_t *out, int max) {
    if (out == NULL || max <= 0) return 0;
    char q[512];
    if (status) {
        // status values are program constants, but escape defensively anyway
        char es[80];
        db_escape(status, es, sizeof(es));
        snprintf(q, sizeof(q), REQUEST_ROWS_SELECT
                 "WHERE r.status='%s' ORDER BY r.request_number", es);
    } else {
        snprintf(q, sizeof(q), REQUEST_ROWS_SELECT "ORDER BY r.request_number");
    }
    if (mysql_query(db, q) != 0) return -1;
    MYSQL_RES *res = mysql_store_result(db);
    if (!res) return -1;
    int n = 0;
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(res)) != NULL && n < max)
        fill_request_row(&out[n++], row);
    mysql_free_result(res);

    // Batch-fill bus assignments (one query instead of one per request).
    if (mysql_query(db, "SELECT request_number,bus_number FROM bus_assignments") != 0)
        return n;
    MYSQL_RES *ares = mysql_store_result(db);
    if (!ares) return n;
    MYSQL_ROW arow;
    while ((arow = mysql_fetch_row(ares)) != NULL) {
        int rn = atoi(arow[0] ? arow[0] : "0");
        int bn = atoi(arow[1] ? arow[1] : "0");
        for (int i = 0; i < n; i++) {
            if (out[i].request_number == rn) { out[i].bus_number = bn; break; }
        }
    }
    mysql_free_result(ares);
    return n;
}

int db_get_request_rows_by_student(int roll_number, request_row_t *out, int max) {
    if (out == NULL || max <= 0) return 0;
    char q[512];
    snprintf(q, sizeof(q), REQUEST_ROWS_SELECT
             "WHERE r.student_roll_number=%d ORDER BY r.request_number DESC",
             roll_number);
    if (mysql_query(db, q) != 0) return -1;
    MYSQL_RES *res = mysql_store_result(db);
    if (!res) return -1;
    int n = 0;
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(res)) != NULL && n < max)
        fill_request_row(&out[n++], row);
    mysql_free_result(res);

    if (mysql_query(db, "SELECT request_number,bus_number FROM bus_assignments") != 0)
        return n;
    MYSQL_RES *ares = mysql_store_result(db);
    if (!ares) return n;
    MYSQL_ROW arow;
    while ((arow = mysql_fetch_row(ares)) != NULL) {
        int rn = atoi(arow[0] ? arow[0] : "0");
        int bn = atoi(arow[1] ? arow[1] : "0");
        for (int i = 0; i < n; i++) {
            if (out[i].request_number == rn) { out[i].bus_number = bn; break; }
        }
    }
    mysql_free_result(ares);
    return n;
}

int db_get_request_status(int request_number, char *out, size_t outsz) {
    if (out == NULL || outsz == 0) return 0;
    out[0] = '\0';
    char q[128];
    snprintf(q, sizeof(q), "SELECT status FROM pickup_requests WHERE request_number=%d",
             request_number);
    if (mysql_query(db, q) != 0) return 0;
    MYSQL_RES *res = mysql_store_result(db);
    if (!res) return 0;
    MYSQL_ROW row = mysql_fetch_row(res);
    int ok = 0;
    if (row && row[0]) {
        snprintf(out, outsz, "%s", row[0]);
        ok = 1;
    }
    mysql_free_result(res);
    return ok;
}

int db_count_buses(void) {
    if (mysql_query(db, "SELECT COUNT(*) FROM buses") != 0) return -1;
    MYSQL_RES *res = mysql_store_result(db);
    if (!res) return -1;
    MYSQL_ROW row = mysql_fetch_row(res);
    int c = (row && row[0]) ? atoi(row[0]) : 0;
    mysql_free_result(res);
    return c;
}

int db_register_bus(int route_pickup, int route_dropoff, int max_capacity) {
    int bn = 1;
    if (mysql_query(db,"SELECT COALESCE(MAX(bus_number),0)+1 FROM buses")==0) {
        MYSQL_RES *r=mysql_store_result(db); if(r){MYSQL_ROW row=mysql_fetch_row(r); if(row&&row[0])bn=atoi(row[0]); mysql_free_result(r);}
    }
    char q[256];
    snprintf(q,sizeof(q),
        "INSERT INTO buses (bus_number,route_pickup,route_dropoff,current_count,max_capacity) "
        "VALUES (%d,%d,%d,0,%d)", bn, route_pickup, route_dropoff, max_capacity);
    if (mysql_query(db,q)!=0) { fprintf(stderr,"Register bus failed: %s\n",mysql_error(db)); return 0; }
    char *loc[]={"JUIT","Ravli PG","Peach Tree","Waknaghat"};
    printf("\nBus %d registered: %s -> %s (Capacity: %d)\n", bn, loc[route_pickup], loc[route_dropoff], max_capacity);
    return bn;
}

int db_update_bus_count(int bus_number, int delta) {
    char q[256];
    snprintf(q,sizeof(q),"UPDATE buses SET current_count=current_count+%d WHERE bus_number=%d AND current_count+%d>=0",delta,bus_number,delta);
    if (mysql_query(db,q)!=0) return 0;
    return mysql_affected_rows(db)>0 ? 1 : 0;
}

// ============================================================
// ASSIGNMENTS
// ============================================================

// Atomically place one request on a bus: the capacity-guarded UPDATE and the
// assignment INSERT succeed or fail together inside one transaction.
int db_assign_request_to_bus(int request_number, int bus_number) {
    if (!db_begin()) return 0;

    // Guarded increment: only takes a seat if the bus still has one, so two
    // concurrent runs can never overfill the same bus.
    char q[512];
    snprintf(q, sizeof(q),
        "UPDATE buses SET current_count=current_count+1 "
        "WHERE bus_number=%d AND current_count<max_capacity", bus_number);
    if (mysql_query(db, q) != 0 || mysql_affected_rows(db) != 1) {
        db_rollback(); return 0;               // bus full or unknown
    }

    snprintf(q, sizeof(q),
        "INSERT INTO bus_assignments (request_number,bus_number) VALUES (%d,%d)",
        request_number, bus_number);
    if (mysql_query(db, q) != 0) {
        db_rollback(); return 0;               // duplicate assignment, FK issue, ...
    }

    if (!db_commit()) { db_rollback(); return 0; }
    return 1;
}

int db_is_request_assigned(int request_number) {
    char q[256];
    snprintf(q,sizeof(q),"SELECT COUNT(*) FROM bus_assignments WHERE request_number=%d",request_number);
    if (mysql_query(db,q)!=0) return 0;
    MYSQL_RES *r=mysql_store_result(db); if(!r) return 0;
    MYSQL_ROW row=mysql_fetch_row(r);
    int c=(row&&row[0])?atoi(row[0]):0;
    mysql_free_result(r); return c>0;
}

int db_unassign_request(int request_number) {
    if (!db_begin()) return 0;

    char q[256]; int bn = 0;
    snprintf(q, sizeof(q), "SELECT bus_number FROM bus_assignments WHERE request_number=%d", request_number);
    if (mysql_query(db, q) != 0) { db_rollback(); return 0; }
    MYSQL_RES *r = mysql_store_result(db);
    if (!r) { db_rollback(); return 0; }
    MYSQL_ROW row = mysql_fetch_row(r);
    if (row && row[0]) bn = atoi(row[0]);
    mysql_free_result(r);
    if (bn == 0) { db_rollback(); printf("\nRequest %d is not assigned.\n", request_number); return 0; }

    snprintf(q, sizeof(q), "DELETE FROM bus_assignments WHERE request_number=%d", request_number);
    if (mysql_query(db, q) != 0) { db_rollback(); return 0; }

    snprintf(q, sizeof(q), "UPDATE buses SET current_count=current_count-1 WHERE bus_number=%d AND current_count>0", bn);
    if (mysql_query(db, q) != 0) { db_rollback(); return 0; }

    if (!db_commit()) { db_rollback(); return 0; }
    printf("\nRequest %d unassigned from bus %d.\n", request_number, bn);
    return 1;
}

// ============================================================
// CREDENTIALS
// ============================================================

int db_verify_role_password(const char *role, const char *password) {
    if (!role || !password) return 0;
    char erole[80]; char q[256];
    db_escape(role, erole, sizeof(erole));
    snprintf(q, sizeof(q), "SELECT password FROM credentials WHERE role='%s'", erole);
    if (mysql_query(db, q) != 0) return 0;
    MYSQL_RES *r = mysql_store_result(db); if (!r) return 0;
    MYSQL_ROW row = mysql_fetch_row(r);
    int ok = 0;
    if (row && row[0]) {
        ok = pw_verify(password, row[0]);
        // Legacy plaintext default creds: re-hash on first successful login.
        if (ok && strncmp(row[0], "pbkdf2-sha256$", 14) != 0) {
            char hashed[PW_HASH_STORAGE_LEN];
            char ehashed[256];
            if (pw_hash(password, hashed, sizeof(hashed)) &&
                db_escape(hashed, ehashed, sizeof(ehashed)) > 0) {
                char uq[512];
                snprintf(uq, sizeof(uq), "UPDATE credentials SET password='%s' WHERE role='%s'",
                         ehashed, erole);
                mysql_query(db, uq);
            }
        }
    }
    mysql_free_result(r); return ok;
}

void db_create_default_credentials(void) {
    if (mysql_query(db, "SELECT COUNT(*) FROM credentials") != 0) return;
    MYSQL_RES *r = mysql_store_result(db); if (!r) return;
    MYSQL_ROW row = mysql_fetch_row(r);
    int c = (row && row[0]) ? atoi(row[0]) : 0;
    mysql_free_result(r); if (c > 0) return;

    char g[PW_HASH_STORAGE_LEN], s[PW_HASH_STORAGE_LEN], eg[256], es[256];
    if (pw_hash("guard123", g, sizeof(g)) && pw_hash("scheduler123", s, sizeof(s)) &&
        db_escape(g, eg, sizeof(eg)) > 0 && db_escape(s, es, sizeof(es)) > 0) {
        char q[700];
        snprintf(q, sizeof(q),
            "INSERT INTO credentials (role,password) VALUES ('guard','%s'),('scheduler','%s')",
            eg, es);
        mysql_query(db, q);
    }
    printf("\n[INFO] Default credentials: guard/guard123, scheduler/scheduler123\n");
}

// ============================================================
// MIGRATION
// ============================================================

void db_migrate_from_text_files(void) {
    if (mysql_query(db,"SELECT COUNT(*) FROM students")!=0) return;
    MYSQL_RES *r=mysql_store_result(db); if(!r) return;
    MYSQL_ROW row=mysql_fetch_row(r);
    int c=(row&&row[0])?atoi(row[0]):0;
    mysql_free_result(r);
    if (c>0) { printf("\n[INFO] Database has data. Skipping migration.\n"); return; }

    printf("\n[INFO] Migrating text files to MySQL...\n");
    FILE *f=fopen("studentregistration.txt","r");
    if (f) {
        char name[35],room[60],hostel[30],phone[15]; int roll;
        while(fgets(name,sizeof(name),f)) {
            name[strcspn(name,"\n")]='\0';
            if(fscanf(f,"%d\n",&roll)!=1) break;
            fgets(room,sizeof(room),f); room[strcspn(room,"\n")]='\0';
            fgets(hostel,sizeof(hostel),f); hostel[strcspn(hostel,"\n")]='\0';
            fgets(phone,sizeof(phone),f); phone[strcspn(phone,"\n")]='\0';
            db_register_student(name,roll,room,hostel,phone,"migrated");
        }
        fclose(f); printf("  [OK] Students migrated\n");
    }

    struct{const char*f;const char*s;} files[]={
        {"pendingrequest.txt","PENDING_APPROVAL"},
        {"approvedrequest.txt","APPROVED"},
        {"rejectedrequest.txt","REJECTED"}
    };
    for (int i=0;i<3;i++) {
        f=fopen(files[i].f,"r"); if(!f) continue;
        int rn,roll; char p[31],d[31],s[35];
        while(fscanf(f,"%d\n",&rn)==1) {
            fscanf(f,"%d\n",&roll);
            fgets(p,sizeof(p),f); p[strcspn(p,"\n")]='\0';
            fgets(d,sizeof(d),f); d[strcspn(d,"\n")]='\0';
            fgets(s,sizeof(s),f);
            int pl=-1,dl=-1;
            if(strcmp(p,"JUIT")==0)pl=0;else if(strcmp(p,"Ravli PG")==0)pl=1;else if(strcmp(p,"Peach Tree")==0)pl=2;else if(strcmp(p,"Waknaghat")==0)pl=3;
            if(strcmp(d,"JUIT")==0)dl=0;else if(strcmp(d,"Ravli PG")==0)dl=1;else if(strcmp(d,"Peach Tree")==0)dl=2;else if(strcmp(d,"Waknaghat")==0)dl=3;
            // Legacy file text is untrusted — escape before splicing into SQL.
            char ep[70], ed[70];
            db_escape(p, ep, sizeof(ep));
            db_escape(d, ed, sizeof(ed));
            char q[512];
            snprintf(q,sizeof(q),"INSERT IGNORE INTO pickup_requests (request_number,student_roll_number,pickup_place,dropoff_place,pickup_location,dropoff_location,direction,status) VALUES (%d,%d,'%s','%s',%d,%d,0,'%s')",rn,roll,ep,ed,pl,dl,files[i].s);
            mysql_query(db,q);
        }
        fclose(f); printf("  [OK] %s requests migrated\n",files[i].s);
    }
    printf("\n[INFO] Migration complete!\n");
}

// ============================================================
// REPORTING
// ============================================================

int db_view_bus_schedule(void) {
    if (mysql_query(db,"SELECT bus_number,route_pickup,route_dropoff,current_count,max_capacity FROM buses ORDER BY bus_number")!=0) return 0;
    MYSQL_RES *r=mysql_store_result(db); if(!r) return 0;
    char *loc[]={"JUIT","Ravli PG","Peach Tree","Waknaghat"};
    printf("\n===== BUS SCHEDULE =====\n");
    int count=0; MYSQL_ROW row;
    while((row=mysql_fetch_row(r))) {
        int bn=atoi(row[0]),p=atoi(row[1]),d=atoi(row[2]),cur=atoi(row[3]),mx=atoi(row[4]);
        printf("\n-----------------------------");
        printf("\nBus %d: %s -> %s (%d/%d seats)",bn,loc[p],loc[d],cur,mx);

        char aq[512];
        snprintf(aq,sizeof(aq),"SELECT r.request_number,s.name,s.roll_number,r.pickup_place,r.dropoff_place FROM bus_assignments ba JOIN pickup_requests r ON ba.request_number=r.request_number JOIN students s ON r.student_roll_number=s.roll_number WHERE ba.bus_number=%d",bn);
        if(mysql_query(db,aq)==0){
            MYSQL_RES *ar=mysql_store_result(db); if(ar){int has=0;MYSQL_ROW ar2;
            while((ar2=mysql_fetch_row(ar))){if(!has){printf("\nAssigned:");has=1;}
            printf("\n  - [%d] %s (Roll: %d) | %s -> %s",atoi(ar2[0]),ar2[1]?ar2[1]:"",atoi(ar2[2]),ar2[3]?ar2[3]:"",ar2[4]?ar2[4]:"");}
            mysql_free_result(ar);}
        }
        printf("\nRemaining: %d",mx-cur);
        printf("\n-----------------------------\n"); count++;
    }
    mysql_free_result(r); return count;
}

int db_view_route_capacity(void) {
    if (mysql_query(db,"SELECT route_pickup,route_dropoff,SUM(max_capacity),SUM(current_count),COUNT(*) FROM buses GROUP BY route_pickup,route_dropoff")!=0) return 0;
    MYSQL_RES *r=mysql_store_result(db); if(!r) return 0;
    char *loc[]={"JUIT","Ravli PG","Peach Tree","Waknaghat"};
    printf("\n===== ROUTE CAPACITY SUMMARY =====\n");
    int count=0; MYSQL_ROW row;
    while((row=mysql_fetch_row(r))) {
        int p=atoi(row[0]),d=atoi(row[1]);
        printf("\n%s -> %s",loc[p],loc[d]);
        printf("\n  Buses: %d",atoi(row[4]));
        printf("\n  Assigned: %d / %d",atoi(row[3]),atoi(row[2]));
        printf("\n  Available: %d",atoi(row[2])-atoi(row[3]));
        count++;
    }
    mysql_free_result(r); printf("\n"); return count;
}
