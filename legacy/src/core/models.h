#ifndef CORE_MODELS_H
#define CORE_MODELS_H

// Fixed shuttle route locations
#define LOC_JUIT       0
#define LOC_RAVLI      1
#define LOC_PEACH_TREE 2
#define LOC_WAKNAGHAT  3
#define LOC_COUNT      4

// Bus constraints
#define MAX_BUS_CAPACITY 30
#define MAX_BUSES        50

// Shared domain structs. These are pure data: no I/O happens here.
// Clients (CLI, future HTTP API) render them; core/ computes with them;
// db/ loads/stores them.

struct student {
    char name[35];
    int student_roll_no;
    char room_number[60];
    char hostel_name[30];
    char phone_number[15];
    char password[31];
};

struct pickuprequest {
    int request_number;
    int student_roll_number;

    int pickup_location;
    int dropoff_location;
    int direction;

    int bus_number;

    char pickup_place[31];
    char dropoff_place[31];
    char status[35];
};

// One registered bus and its live load.
typedef struct {
    int bus_number;
    int route_pickup;      // LOC_* constant
    int route_dropoff;     // LOC_* constant
    int current_count;     // students currently assigned
    int max_capacity;
} bus_t;

// Minimal route info for an approved request (all the assignment
// algorithm needs; avoids dragging full request rows into core/).
typedef struct {
    int request_number;
    int pickup_location;   // LOC_* constant
    int dropoff_location;  // LOC_* constant
} request_route_t;

// Summary of a request for queue/list views (guard's pending queue).
typedef struct {
    int request_number;
    int student_roll_number;
    char pickup_place[31];
    char dropoff_place[31];
} request_summary_t;

// Full request row joined with student info (list views, API responses).
typedef struct {
    int  request_number;
    char student_name[35];
    int  student_roll_number;
    char hostel_name[30];
    char room_number[60];
    char phone_number[15];
    char pickup_place[31];
    char dropoff_place[31];
    char status[35];
    int  bus_number;   // 0 = not assigned to a bus
} request_row_t;

#endif // CORE_MODELS_H
