// Endpoint handlers for the shuttle API. Parse JSON in, call core/db,
// write JSON out. No socket code here — server.c owns transport.
//
// Role model: 0=student, 1=guard, 2=scheduler.
//   - students: create + list their own requests
//   - guard:    list any requests, approve/reject pending ones
//   - scheduler: buses (list/register), assignment (run/unassign), reports

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include "handlers.h"
#include "json.h"
#include "src/db/database.h"
#include "src/core/models.h"
#include "src/core/service.h"
#include "src/core/crypto.h"

// ------------------------------------------------------------
// Sessions: 128-bit CSPRNG tokens, 8-hour sliding expiry.
// Still in-memory (lost on restart — documented limitation).
// ------------------------------------------------------------

#define MAX_SESSIONS 64
#define TOKEN_LEN    33                 // 32 hex chars + NUL
#define SESSION_TTL  (8 * 60 * 60)      // seconds; sliding

typedef struct {
    int  active;
    char token[TOKEN_LEN];
    int  role;
    int  roll_number;   // students only
    time_t expires_at;
} session_t;

static session_t sessions[MAX_SESSIONS];

void api_handlers_init(void)     { memset(sessions, 0, sizeof(sessions)); }
void api_handlers_shutdown(void) { memset(sessions, 0, sizeof(sessions)); }

static void session_fill_token(session_t *s) {
    unsigned char raw[16];
    if (crypto_random_bytes(raw, sizeof(raw))) {
        static const char hex[] = "0123456789abcdef";
        for (int i = 0; i < 16; i++) {
            s->token[i * 2]     = hex[raw[i] >> 4];
            s->token[i * 2 + 1] = hex[raw[i] & 0x0f];
        }
        s->token[32] = '\0';
    } else {
        s->token[0] = '\0';   // session_create treats this as failure
    }
}

static session_t *session_find(const char *token) {
    if (token == NULL || token[0] == '\0') return NULL;
    time_t now = time(NULL);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sessions[i].active && strcmp(sessions[i].token, token) == 0) {
            if (now >= sessions[i].expires_at) {   // expired
                sessions[i].active = 0;
                return NULL;
            }
            sessions[i].expires_at = now + SESSION_TTL;   // sliding renewal
            return &sessions[i];
        }
    }
    return NULL;
}

static void session_create(session_t *out, int role, int roll_number) {
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (!sessions[i].active) {
            session_fill_token(&sessions[i]);
            if (sessions[i].token[0] == '\0') break;  // RNG failure -> no session
            sessions[i].active = 1;
            sessions[i].role = role;
            sessions[i].roll_number = roll_number;
            sessions[i].expires_at = time(NULL) + SESSION_TTL;
            memcpy(out, &sessions[i], sizeof(*out));
            return;
        }
    }
    out->active = 0;
}

// ------------------------------------------------------------
// Response helpers
// ------------------------------------------------------------

static int respond(char *res, size_t res_size, int status, const char *body) {
    snprintf(res, res_size, "%s", body);
    return status;
}

static int respond_error(char *res, size_t res_size, int status, const char *msg) {
    char esc[160];
    json_escape_to(msg, esc, sizeof(esc));
    char body[224];
    snprintf(body, sizeof(body), "{\"error\":\"%s\"}", esc);
    return respond(res, res_size, status, body);
}

// ------------------------------------------------------------
// GET|POST /api/health
// ------------------------------------------------------------

static int handle_health(char *res, size_t res_size) {
    if (db_ping())
        return respond(res, res_size, 200, "{\"status\":\"ok\",\"database\":\"up\"}");
    return respond(res, res_size, 200, "{\"status\":\"ok\",\"database\":\"down\"}");
}

// ------------------------------------------------------------
// POST /api/register   (public; mirrors CLI student registration)
//   {"roll_number":261030195,"name":"...","room":"...","hostel":"...","phone":"...","password":"..."}
// ------------------------------------------------------------

static int handle_register(const char *body, char *res, size_t res_size) {
    long roll;
    char name[35], room[60], hostel[30], phone[15], password[31];
    if (!json_get_int(body, "roll_number", &roll) || roll <= 0 ||
        !json_get_string(body, "name", name, sizeof(name)) ||
        !json_get_string(body, "room", room, sizeof(room)) ||
        !json_get_string(body, "hostel", hostel, sizeof(hostel)) ||
        !json_get_string(body, "phone", phone, sizeof(phone)) ||
        !json_get_string(body, "password", password, sizeof(password))) {
        return respond_error(res, res_size, 400,
            "roll_number, name, room, hostel, phone and password are required");
    }
    if (strlen(password) < 4)
        return respond_error(res, res_size, 400, "password must be at least 4 characters");
    if (db_student_exists((int)roll))
        return respond_error(res, res_size, 409, "a student with this roll number already exists");
    if (!db_register_student(name, (int)roll, room, hostel, phone, password))
        return respond_error(res, res_size, 500, "registration failed");
    return respond(res, res_size, 201, "{\"registered\":true}");
}

// ------------------------------------------------------------
// POST /api/login
// ------------------------------------------------------------

static int handle_login(const char *body, char *res, size_t res_size) {
    char role[16], password[64];
    if (!json_get_string(body, "role", role, sizeof(role)) ||
        !json_get_string(body, "password", password, sizeof(password))) {
        return respond_error(res, res_size, 400, "role and password are required");
    }

    if (strcmp(role, "student") == 0) {
        long roll;
        if (!json_get_int(body, "roll_number", &roll))
            return respond_error(res, res_size, 400, "roll_number is required for students");
        if (!db_verify_student_password((int)roll, password))
            return respond_error(res, res_size, 401, "invalid credentials");
        struct student s;
        if (!db_find_student((int)roll, s.name, s.room_number, s.hostel_name, s.phone_number))
            return respond_error(res, res_size, 401, "invalid credentials");
        char name_esc[80];
        json_escape_to(s.name, name_esc, sizeof(name_esc));
        session_t sess;
        session_create(&sess, 0, (int)roll);
        if (!sess.active) return respond_error(res, res_size, 503, "too many sessions");
        char out[256];
        snprintf(out, sizeof(out),
                 "{\"token\":\"%s\",\"role\":\"student\",\"roll_number\":%ld,\"name\":\"%s\"}",
                 sess.token, roll, name_esc);
        return respond(res, res_size, 200, out);
    }

    if (strcmp(role, "guard") == 0 || strcmp(role, "scheduler") == 0) {
        if (!db_verify_role_password(role, password))
            return respond_error(res, res_size, 401, "invalid credentials");
        session_t sess;
        session_create(&sess, strcmp(role, "guard") == 0 ? 1 : 2, 0);
        if (!sess.active) return respond_error(res, res_size, 503, "too many sessions");
        char out[128];
        snprintf(out, sizeof(out), "{\"token\":\"%s\",\"role\":\"%s\"}", sess.token, role);
        return respond(res, res_size, 200, out);
    }

    return respond_error(res, res_size, 400, "unknown role");
}

// ------------------------------------------------------------
// POST /api/requests   (student)
// ------------------------------------------------------------

static int handle_create_request(const char *body, const session_t *sess,
                                 char *res, size_t res_size) {
    char pickup[31], dropoff[31];
    if (!json_get_string(body, "pickup_place", pickup, sizeof(pickup)) ||
        !json_get_string(body, "dropoff_place", dropoff, sizeof(dropoff))) {
        return respond_error(res, res_size, 400, "pickup_place and dropoff_place are required");
    }

    int p = core_location_from_name(pickup);
    int d = core_location_from_name(dropoff);
    if (!core_route_is_valid(p, d))
        return respond_error(res, res_size, 400, "unknown pickup/dropoff or same-location route");

    int rn = db_create_request(sess->roll_number, pickup, dropoff);
    if (rn <= 0)
        return respond_error(res, res_size, 500, "could not create request");

    char out[128];
    snprintf(out, sizeof(out), "{\"request_number\":%d,\"status\":\"PENDING_APPROVAL\"}", rn);
    return respond(res, res_size, 201, out);
}

// ------------------------------------------------------------
// GET /api/requests            (guard/scheduler; ?status= filter)
// GET /api/requests/mine       (student)
// POST /api/requests/{id}/approve | /reject   (guard)
// ------------------------------------------------------------

// Emit a JSON array of request rows (caller wraps/validates role).
static int emit_request_rows(const request_row_t *rows, int n,
                             char *res, size_t res_size) {
    size_t used = (size_t)snprintf(res, res_size, "{\"count\":%d,\"requests\":[", n);
    for (int i = 0; i < n; i++) {
        char name_e[80], hostel_e[70], room_e[130], phone_e[40];
        char pickup_e[70], dropoff_e[70], status_e[80];
        json_escape_to(rows[i].student_name,  name_e,   sizeof(name_e));
        json_escape_to(rows[i].hostel_name,   hostel_e, sizeof(hostel_e));
        json_escape_to(rows[i].room_number,   room_e,   sizeof(room_e));
        json_escape_to(rows[i].phone_number,  phone_e,  sizeof(phone_e));
        json_escape_to(rows[i].pickup_place,  pickup_e, sizeof(pickup_e));
        json_escape_to(rows[i].dropoff_place, dropoff_e,sizeof(dropoff_e));
        json_escape_to(rows[i].status,        status_e, sizeof(status_e));

        char item[640];
        int len = snprintf(item, sizeof(item),
            "%s{\"request_number\":%d,\"student_name\":\"%s\",\"roll_number\":%d,"
            "\"hostel\":\"%s\",\"room\":\"%s\",\"phone\":\"%s\","
            "\"pickup\":\"%s\",\"dropoff\":\"%s\",\"status\":\"%s\",\"bus\":%d}",
            i ? "," : "", rows[i].request_number, name_e, rows[i].student_roll_number,
            hostel_e, room_e, phone_e, pickup_e, dropoff_e, status_e, rows[i].bus_number);

        if (used + (size_t)len + 2 >= res_size) { used += (size_t)snprintf(res + used, res_size - used, "]"); return 200; }
        memcpy(res + used, item, (size_t)len); used += (size_t)len;
    }
    snprintf(res + used, res_size - used, "]}");
    return 200;
}

static int handle_list_requests(const char *query, char *res, size_t res_size) {
    char status[35] = "";
    if (query && strncmp(query, "status=", 7) == 0) {
        char raw[35];
        snprintf(raw, sizeof(raw), "%s", query + 7);
        char *amp = strchr(raw, '&');
        if (amp) *amp = '\0';
        if (strcmp(raw, "PENDING_APPROVAL") == 0 || strcmp(raw, "APPROVED") == 0 ||
            strcmp(raw, "REJECTED") == 0) {
            snprintf(status, sizeof(status), "%s", raw);
        } else {
            return respond_error(res, res_size, 400,
                "status must be PENDING_APPROVAL, APPROVED or REJECTED");
        }
    }
    request_row_t rows[256];
    int n = db_get_request_rows_by_status(status[0] ? status : NULL, rows, 256);
    if (n < 0) return respond_error(res, res_size, 500, "database error");
    return emit_request_rows(rows, n, res, res_size);
}

static int handle_my_requests(const session_t *sess, char *res, size_t res_size) {
    request_row_t rows[256];
    int n = db_get_request_rows_by_student(sess->roll_number, rows, 256);
    if (n < 0) return respond_error(res, res_size, 500, "database error");
    return emit_request_rows(rows, n, res, res_size);
}

static int handle_lifecycle(int request_number, const char *new_status,
                            char *res, size_t res_size) {
    int ok = (strcmp(new_status, "APPROVED") == 0)
        ? core_approve_request(request_number)
        : core_reject_request(request_number);
    if (!ok) {
        // Distinguish "does not exist" from "not pending" for the client.
        char cur[35];
        if (!db_get_request_status(request_number, cur, sizeof(cur)))
            return respond_error(res, res_size, 404, "request not found");
        return respond_error(res, res_size, 409, "request is not pending");
    }
    char out[96];
    snprintf(out, sizeof(out), "{\"request_number\":%d,\"status\":\"%s\"}",
             request_number, new_status);
    return respond(res, res_size, 200, out);
}

// ------------------------------------------------------------
// GET|POST /api/buses, POST /api/buses/assign,
// POST /api/assignments/unassign, GET /api/reports/capacity
// ------------------------------------------------------------

static int handle_buses(const char *method, const char *body, char *res, size_t res_size) {
    if (strcmp(method, "POST") == 0) {
        long p, d, cap;
        if (!json_get_int(body, "route_pickup", &p) ||
            !json_get_int(body, "route_dropoff", &d) ||
            !json_get_int(body, "max_capacity", &cap))
            return respond_error(res, res_size, 400,
                "route_pickup, route_dropoff and max_capacity are required");
        if (!core_route_is_valid((int)p, (int)d))
            return respond_error(res, res_size, 400, "invalid route (0=JUIT,1=Ravli PG,2=Peach Tree,3=Waknaghat)");
        if (cap < 1 || cap > MAX_BUS_CAPACITY)
            return respond_error(res, res_size, 400, "max_capacity must be 1-30");
        int bn = db_register_bus((int)p, (int)d, (int)cap);
        if (bn <= 0) return respond_error(res, res_size, 500, "could not register bus");
        char out[96];
        snprintf(out, sizeof(out), "{\"bus_number\":%d,\"route_pickup\":%ld,\"route_dropoff\":%ld,\"max_capacity\":%ld}",
                 bn, p, d, cap);
        return respond(res, res_size, 201, out);
    }

    bus_t buses[MAX_BUSES];
    int n = db_get_buses(buses, MAX_BUSES);
    if (n < 0) return respond_error(res, res_size, 500, "database error");
    static const char *loc[] = { "JUIT", "Ravli PG", "Peach Tree", "Waknaghat" };
    size_t used = (size_t)snprintf(res, res_size, "{\"count\":%d,\"buses\":[", n);
    for (int i = 0; i < n; i++) {
        char item[256];
        int len = snprintf(item, sizeof(item),
            "%s{\"bus_number\":%d,\"route\":\"%s -> %s\",\"route_pickup\":%d,\"route_dropoff\":%d,"
            "\"assigned\":%d,\"capacity\":%d}",
            i ? "," : "", buses[i].bus_number,
            loc[buses[i].route_pickup % LOC_COUNT], loc[buses[i].route_dropoff % LOC_COUNT],
            buses[i].route_pickup, buses[i].route_dropoff,
            buses[i].current_count, buses[i].max_capacity);
        if (used + (size_t)len + 2 >= res_size) { snprintf(res + used, res_size - used, "]"); return 200; }
        memcpy(res + used, item, (size_t)len); used += (size_t)len;
    }
    snprintf(res + used, res_size - used, "]}");
    return 200;
}

static int handle_assign(char *res, size_t res_size) {
    core_assign_result_t r;
    if (!core_assign_approved_requests(&r))
        return respond_error(res, res_size, 500, "database error during assignment");
    char out[320];
    snprintf(out, sizeof(out),
        "{\"assigned\":%d,\"skipped_already_assigned\":%d,\"no_bus_available\":%d,\"warned_buses\":[",
        r.assigned_count, r.skipped_already_assigned, r.no_bus_available);
    size_t used = strlen(out);
    for (int w = 0; w < r.warned_count; w++) {
        int len = snprintf(out + used, sizeof(out) - used, "%s%d", w ? "," : "",
                           r.warned_bus_numbers[w]);
        if (len < 0 || used + (size_t)len + 2 >= sizeof(out)) break;
        used += (size_t)len;
    }
    snprintf(out + used, sizeof(out) - used, "]}");
    return respond(res, res_size, 200, out);
}

static int handle_unassign(const char *body, char *res, size_t res_size) {
    long rn;
    if (!json_get_int(body, "request_number", &rn))
        return respond_error(res, res_size, 400, "request_number is required");
    if (!db_unassign_request((int)rn)) {
        char cur[35];
        if (!db_get_request_status((int)rn, cur, sizeof(cur)))
            return respond_error(res, res_size, 404, "request not found");
        return respond_error(res, res_size, 404, "request is not assigned to a bus");
    }
    char out[96];
    snprintf(out, sizeof(out), "{\"request_number\":%ld,\"assigned\":false}", rn);
    return respond(res, res_size, 200, out);
}

static int handle_capacity(char *res, size_t res_size) {
    bus_t buses[MAX_BUSES];
    int n = db_get_buses(buses, MAX_BUSES);
    if (n < 0) return respond_error(res, res_size, 500, "database error");

    // Aggregate by route pair (routes are LOC_* pairs; LOC_COUNT^2 upper bound).
    struct { int p, d, bus_count, assigned, capacity; } agg[LOC_COUNT * LOC_COUNT];
    int agg_n = 0;
    for (int i = 0; i < n; i++) {
        int k = -1;
        for (int a = 0; a < agg_n; a++)
            if (agg[a].p == buses[i].route_pickup && agg[a].d == buses[i].route_dropoff) { k = a; break; }
        if (k < 0 && agg_n < LOC_COUNT * LOC_COUNT) {
            k = agg_n++;
            agg[k].p = buses[i].route_pickup; agg[k].d = buses[i].route_dropoff;
            agg[k].bus_count = 0; agg[k].assigned = 0; agg[k].capacity = 0;
        }
        if (k >= 0) {
            agg[k].bus_count++;
            agg[k].assigned  += buses[i].current_count;
            agg[k].capacity  += buses[i].max_capacity;
        }
    }

    static const char *loc[] = { "JUIT", "Ravli PG", "Peach Tree", "Waknaghat" };
    size_t used = (size_t)snprintf(res, res_size, "{\"count\":%d,\"routes\":[", agg_n);
    for (int i = 0; i < agg_n; i++) {
        char item[256];
        int len = snprintf(item, sizeof(item),
            "%s{\"route\":\"%s -> %s\",\"buses\":%d,\"assigned\":%d,\"capacity\":%d,\"available\":%d}",
            i ? "," : "", loc[agg[i].p % LOC_COUNT], loc[agg[i].d % LOC_COUNT],
            agg[i].bus_count, agg[i].assigned, agg[i].capacity,
            agg[i].capacity - agg[i].assigned);
        if (used + (size_t)len + 2 >= res_size) { snprintf(res + used, res_size - used, "]"); return 200; }
        memcpy(res + used, item, (size_t)len); used += (size_t)len;
    }
    snprintf(res + used, res_size - used, "]}");
    return 200;
}

// ------------------------------------------------------------
// Dispatch
//   auth_header: the raw Authorization header value ("" if absent)
//   query:       raw query string ("" if absent)
// ------------------------------------------------------------

int api_handle_request(const char *method, const char *path, const char *query,
                       const char *auth_header, const char *body,
                       char *res_body, size_t res_size) {
    // ---- public endpoints ----
    if (strcmp(path, "/api/health") == 0) {
        if (strcmp(method, "GET") != 0 && strcmp(method, "POST") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed");
        return handle_health(res_body, res_size);
    }
    if (strcmp(path, "/api/login") == 0) {
        if (strcmp(method, "POST") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed; use POST");
        return handle_login(body ? body : "", res_body, res_size);
    }
    if (strcmp(path, "/api/register") == 0) {
        if (strcmp(method, "POST") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed; use POST");
        return handle_register(body ? body : "", res_body, res_size);
    }

    // ---- authenticated endpoints ----
    const char *bearer = auth_header ? strstr(auth_header, "Bearer ") : NULL;
    session_t *sess = session_find(bearer ? bearer + 7 : NULL);

    if (strcmp(path, "/api/requests") == 0) {
        if (strcmp(method, "POST") == 0) {
            if (!sess) return respond_error(res_body, res_size, 401, "missing or invalid token");
            if (sess->role != 0) return respond_error(res_body, res_size, 403, "student role required");
            return handle_create_request(body ? body : "", sess, res_body, res_size);
        }
        if (strcmp(method, "GET") == 0) {
            if (!sess) return respond_error(res_body, res_size, 401, "missing or invalid token");
            if (sess->role != 1 && sess->role != 2)
                return respond_error(res_body, res_size, 403, "guard or scheduler role required");
            return handle_list_requests(query, res_body, res_size);
        }
        return respond_error(res_body, res_size, 405, "method not allowed");
    }

    if (strcmp(path, "/api/requests/mine") == 0) {
        if (strcmp(method, "GET") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed; use GET");
        if (!sess) return respond_error(res_body, res_size, 401, "missing or invalid token");
        if (sess->role != 0) return respond_error(res_body, res_size, 403, "student role required");
        return handle_my_requests(sess, res_body, res_size);
    }

    // POST /api/requests/{id}/approve  |  /api/requests/{id}/reject
    int req_id = -1;
    const char *action = NULL;
    if (sscanf(path, "/api/requests/%d/", &req_id) == 1) {
        const char *tail = strchr(path + strlen("/api/requests/"), '/');
        if (tail) action = tail + 1;
    }
    if (action && (strcmp(action, "approve") == 0 || strcmp(action, "reject") == 0)) {
        if (strcmp(method, "POST") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed; use POST");
        if (!sess) return respond_error(res_body, res_size, 401, "missing or invalid token");
        if (sess->role != 1) return respond_error(res_body, res_size, 403, "guard role required");
        return handle_lifecycle(req_id, strcmp(action, "approve") == 0 ? "APPROVED" : "REJECTED",
                                res_body, res_size);
    }

    if (strcmp(path, "/api/buses") == 0) {
        if (strcmp(method, "GET") != 0 && strcmp(method, "POST") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed");
        if (!sess) return respond_error(res_body, res_size, 401, "missing or invalid token");
        if (sess->role != 2) return respond_error(res_body, res_size, 403, "scheduler role required");
        return handle_buses(method, body ? body : "", res_body, res_size);
    }
    if (strcmp(path, "/api/buses/assign") == 0) {
        if (strcmp(method, "POST") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed; use POST");
        if (!sess) return respond_error(res_body, res_size, 401, "missing or invalid token");
        if (sess->role != 2) return respond_error(res_body, res_size, 403, "scheduler role required");
        return handle_assign(res_body, res_size);
    }
    if (strcmp(path, "/api/assignments/unassign") == 0) {
        if (strcmp(method, "POST") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed; use POST");
        if (!sess) return respond_error(res_body, res_size, 401, "missing or invalid token");
        if (sess->role != 2) return respond_error(res_body, res_size, 403, "scheduler role required");
        return handle_unassign(body ? body : "", res_body, res_size);
    }
    if (strcmp(path, "/api/reports/capacity") == 0) {
        if (strcmp(method, "GET") != 0)
            return respond_error(res_body, res_size, 405, "method not allowed; use GET");
        if (!sess) return respond_error(res_body, res_size, 401, "missing or invalid token");
        if (sess->role != 2 && sess->role != 1)
            return respond_error(res_body, res_size, 403, "scheduler or guard role required");
        return handle_capacity(res_body, res_size);
    }

    return respond_error(res_body, res_size, 404, "not found");
}
