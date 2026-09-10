// Standalone test runner for the core assignment algorithm.
// Links src/core/service.c with tests/stub_db.c (no MySQL needed).

#include <stdio.h>
#include <string.h>
#include "stub_db.h"
#include "src/core/service.h"

static int tests_run;
static int tests_failed;

#define CHECK(cond) do { \
    if (!(cond)) { \
        printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
        tests_failed++; \
    } \
} while (0)

#define RUN(name) do { \
    printf("[RUN ] %s\n", name); \
    tests_run++; \
} while (0)

// Locations shorthand
#define J LOC_JUIT
#define R LOC_RAVLI
#define P LOC_PEACH_TREE
#define W LOC_WAKNAGHAT

static void test_full_bus_skipped(void) {
    RUN("full bus is skipped; next matching bus receives the request");
    stub_reset();
    // Bus 1: exact route, already full.
    stub_add_bus(1, J, W, 30, 30);
    // Bus 2: same route with room.
    stub_add_bus(2, J, W, 0, 10);
    stub_add_request(101, J, W);

    core_assign_result_t res;
    CHECK(core_assign_approved_requests(&res) == 1);
    CHECK(res.assigned_count == 1);
    CHECK(res.no_bus_available == 0);
    CHECK(db_is_request_assigned(101) == 1);
    // Must land on bus 2, not the full bus 1.
    bus_t buses[MAX_BUSES];
    db_get_buses(buses, MAX_BUSES);
    CHECK(buses[0].current_count == 30); // unchanged
    CHECK(buses[1].current_count == 1);
    CHECK(res.warned_count == 0);        // 1/10 is not >= 80%
}

static void test_mixed_routes(void) {
    RUN("requests only land on exact-route buses, first match wins");
    stub_reset();
    stub_add_bus(10, J, R, 0, 5);   // different route
    stub_add_bus(11, J, W, 0, 5);   // exact route for req 201
    stub_add_bus(12, J, W, 0, 5);   // same route, second match
    stub_add_bus(13, R, W, 0, 5);   // unrelated route
    stub_add_request(201, J, W);    // should take bus 11
    stub_add_request(202, J, R);    // should take bus 10
    stub_add_request(203, W, J);    // reverse direction: no bus serves it

    core_assign_result_t res;
    CHECK(core_assign_approved_requests(&res) == 1);
    CHECK(res.assigned_count == 2);
    CHECK(res.no_bus_available == 1);
    CHECK(db_is_request_assigned(201) == 1);
    CHECK(db_is_request_assigned(202) == 1);
    CHECK(db_is_request_assigned(203) == 0);
    bus_t buses[MAX_BUSES];
    int n = db_get_buses(buses, MAX_BUSES);
    CHECK(n == 4);
    CHECK(buses[0].current_count == 1);  // bus 10
    CHECK(buses[1].current_count == 1);  // bus 11 (not 12)
    CHECK(buses[2].current_count == 0);  // bus 12 untouched
}

static void test_capacity_warning_once(void) {
    RUN("80% warning fires once per bus and is marked FULL at 100%");
    stub_reset();
    stub_add_bus(20, J, W, 9, 10);   // one seat free; first assign -> 100%
    stub_add_bus(21, J, W, 0, 10);   // backup bus
    stub_add_request(301, J, W);     // -> bus 20 at 100% (warn + FULL)
    stub_add_request(302, J, W);     // -> bus 21 at 10%  (no warn)
    stub_add_request(303, J, W);     // -> bus 21 at 20%  (no warn)

    core_assign_result_t res;
    CHECK(core_assign_approved_requests(&res) == 1);
    CHECK(res.assigned_count == 3);
    CHECK(res.warned_count == 1);
    CHECK(res.warned_bus_numbers[0] == 20);
    bus_t buses[MAX_BUSES];
    db_get_buses(buses, MAX_BUSES);
    CHECK(buses[0].current_count == 10);
    CHECK(buses[1].current_count == 2);
}

static void test_already_assigned_skipped(void) {
    RUN("already-assigned requests are skipped, not double-placed");
    stub_reset();
    stub_add_bus(30, J, W, 1, 10);   // req 401 already seated here
    stub_add_request(401, J, W);
    stub_add_request(402, J, W);

    // Mark 401 as assigned in the stub.
    db_assign_request_to_bus(401, 30);
    int before = 0;
    bus_t buses[MAX_BUSES];
    db_get_buses(buses, MAX_BUSES);
    before = buses[0].current_count;

    core_assign_result_t res;
    CHECK(core_assign_approved_requests(&res) == 1);
    CHECK(res.assigned_count == 1);          // only 402 placed
    CHECK(res.skipped_already_assigned == 1);
    db_get_buses(buses, MAX_BUSES);
    CHECK(buses[0].current_count == before + 1);
}

static void test_db_error_path(void) {
    RUN("db failure during assign leaves request unassigned, run continues");
    stub_reset();
    stub_add_bus(50, J, W, 0, 10);
    stub_add_request(601, J, W);
    stub_add_request(602, J, W);
    stub_fail_next_assign();                 // 601's insert will fail

    core_assign_result_t res;
    CHECK(core_assign_approved_requests(&res) == 1);
    CHECK(res.assigned_count == 1);          // 602 still placed
    CHECK(db_is_request_assigned(601) == 0);
    CHECK(db_is_request_assigned(602) == 1);
}

static void test_empty_inputs(void) {
    RUN("no buses / no requests yield clean no-op runs");
    stub_reset();
    core_assign_result_t res;
    CHECK(core_assign_approved_requests(&res) == 1);
    CHECK(res.assigned_count == 0 && res.no_bus_available == 0);

    stub_add_request(701, J, W);             // request with no fleet
    CHECK(core_assign_approved_requests(&res) == 1);
    CHECK(res.assigned_count == 0);
    CHECK(res.no_bus_available == 1);
}

static void test_bad_args(void) {
    RUN("NULL result pointer tolerated; invalid pointer rejected defensively");
    stub_reset();
    stub_add_bus(60, J, W, 0, 10);
    stub_add_request(801, J, W);
    // NULL result must not crash and must still assign.
    CHECK(core_assign_approved_requests(NULL) == 1);
    CHECK(db_is_request_assigned(801) == 1);
    // Stub contract: bad buffer args return 0 (defensive), not -1.
    CHECK(db_get_buses(NULL, 5) == 0);
    CHECK(db_get_request_routes_by_status("APPROVED", NULL, 5) == 0);
}

int main(void) {
    test_full_bus_skipped();
    test_mixed_routes();
    test_capacity_warning_once();
    test_already_assigned_skipped();
    test_db_error_path();
    test_empty_inputs();
    test_bad_args();

    printf("\n%d test(s) run, %d assertion failure(s)\n", tests_run, tests_failed);
    return tests_failed ? 1 : 0;
}
