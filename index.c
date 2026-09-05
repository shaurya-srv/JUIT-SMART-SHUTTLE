#include<stdio.h>
#include<string.h>
#include<stdlib.h>

//data storage of student
struct student {
    char name[35];
    int student_roll_no;
    char room_number[60];
    char hostel_name[30];
    char phone_number[15];
};
//data storage of pickup and drop request
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
// Fixed shuttle route locations
#define JUIT 0
#define RAVLI 1
#define PEACH_TREE 2
#define WAKNAGHAT 3

// Bus data storage
struct bus {
    int bus_number;
    int route_pickup;       // pickup location number
    int route_dropoff;      // dropoff location number
    int current_count;      // number of students assigned
    int max_capacity;       // maximum students per bus
};

#define MAX_BUS_CAPACITY 30
#define MAX_BUSES 50
#define BUS_SCHEDULE_FILE "busschedule.txt"
#define BUS_ASSIGNMENTS_FILE "busassignments.txt"

// Helper: get a human-readable route name from a bus
void getBusRouteName(struct bus *b, char *buf, int size) {
    char *loc_names[] = {"JUIT", "Ravli PG", "Peach Tree", "Waknaghat"};
    if (b->route_pickup >= 0 && b->route_pickup <= 3 &&
        b->route_dropoff >= 0 && b->route_dropoff <= 3)
        snprintf(buf, size, "%s -> %s", loc_names[b->route_pickup], loc_names[b->route_dropoff]);
    else
        snprintf(buf, size, "Unknown Route");
}

// function to count the number of requests made by a student (to make the counter static and not reset every time the function is called)
int getNextRequestNumber(){
    FILE *file;
    int request_number;
    int highest_number = 0;

    char *files[] = {
        "pendingrequest.txt",
        "approvedrequest.txt",
        "rejectedrequest.txt"
    };

    int file_count = 3;

    for (int i = 0; i < file_count; i++)
    {
        file = fopen(files[i], "r");

        if (file == NULL)
        {
            continue;
        }

        while (fscanf(file, "%d", &request_number) == 1)
        {
            if (request_number > highest_number){
                highest_number = request_number;
            }
            /*
             * Skip the remaining 4 lines of this request:
             * student roll number
             * pickup place
             * dropoff place
             * status
             */
            fscanf(file, "%*[^\n]\n");
            fscanf(file, "%*[^\n]\n");
            fscanf(file, "%*[^\n]\n");
            fscanf(file, "%*[^\n]\n");
        }

        fclose(file);
    }

    return highest_number + 1;
}
// helper: read a line of text safely and strip the trailing newline
void read_line(char *buffer, int size) {
    if (fgets(buffer, size, stdin) != NULL) {
        buffer[strcspn(buffer, "\n")] = '\0';
    } else {
        buffer[0] = '\0';
    }
}
// helper: read an integer safely, consuming the trailing newline too
int read_int(void) {
    char line[64];
    read_line(line, sizeof(line));
    return atoi(line);
}
int studentExists(int roll_number){
    FILE *file;
    char name[35];
    int stored_roll;
    char room[60];
    char hostel[30];
    char phone[15];

    file = fopen("studentregistration.txt", "r");

    if (file == NULL)
    {
        return 0;
    }

    while (fgets(name, sizeof(name), file) != NULL)
    {
        if (fscanf(file, "%d\n", &stored_roll) != 1)
        {
            break;
        }

        fgets(room, sizeof(room), file);
        fgets(hostel, sizeof(hostel), file);
        fgets(phone, sizeof(phone), file);

        if (stored_roll == roll_number)
        {
            fclose(file);
            return 1;
        }
    }

    fclose(file);
    return 0;
}
// function to store student information and save it in the file for later calling
void studentregistration(struct student *s) {
    printf("\nSTUDENT REGISTRATION\n");
    printf("Enter your roll number: ");
    s->student_roll_no = read_int();
    if (studentExists(s->student_roll_no)){
        printf("\nA student with roll number %d is already registered.\n",s->student_roll_no);
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
    getchar(); // consume the newline character left in the input buffer

    FILE *file;
    file = fopen("studentregistration.txt", "a");
    if(file == NULL) 
    {
        printf("\nError: Could not create student registration file.\n");
        return;
    }
    fprintf(file, "%s\n", s->name);
    fprintf(file, "%d\n", s->student_roll_no);
    fprintf(file, "%s\n", s->room_number);
    fprintf(file, "%s\n", s->hostel_name);
    fprintf(file, "%s\n", s->phone_number);

    fclose(file);
    printf("\nStudent registration successful!\n");

}
// finding students using there roll no to not call entire student informtion
int findstudent(int roll_number, struct student *s) {
    FILE *file;
    file = fopen("studentregistration.txt", "r");
    if (file == NULL) {
        printf("\nError: Could not open student registration file.\n");
        return 0;
    }

    while (fgets(s->name, sizeof(s->name), file) != NULL) {
        fscanf(file, "%d ", &s->student_roll_no);
        fgets(s->room_number, sizeof(s->room_number), file);
        fgets(s->hostel_name, sizeof(s->hostel_name), file);
        fgets(s->phone_number, sizeof(s->phone_number), file);

        // Remove trailing newlines
        s->name[strcspn(s->name, "\n")] = '\0';
        s->room_number[strcspn(s->room_number, "\n")] = '\0';
        s->hostel_name[strcspn(s->hostel_name, "\n")] = '\0';
        s->phone_number[strcspn(s->phone_number, "\n")] = '\0';

        if (s->student_roll_no == roll_number) {
            fclose(file);
            return 1;
        }
    }

    fclose(file);
    printf("\nStudent with roll number %d not found.\n", roll_number);
    return 0;
}
int getLocationNumber(char location[]) {

    if (strcmp(location, "JUIT") == 0)
        return JUIT;

    if (strcmp(location, "Ravli PG") == 0)
        return RAVLI;

    if (strcmp(location, "Peach Tree") == 0)
        return PEACH_TREE;

    if (strcmp(location, "Waknaghat") == 0)
        return WAKNAGHAT;

    return -1;
}
int getDirection(int pickup, int dropoff) {

    if (pickup < dropoff)
        return 1;       // OUTBOUND

    if (pickup > dropoff)
        return -1;      // RETURN

    return 0;           // SAME LOCATION
}
int chooseLocation() {

    int choice;

    printf("\nAvailable Locations:\n");
    printf("1. JUIT Main Gate\n");
    printf("2. Ravli PG\n");
    printf("3. Peach Tree (Azad Extension)\n");
    printf("4. Waknaghat\n");

    printf("\nEnter location: ");
    choice = read_int();

    if (choice < 1 || choice > 4) {
        printf("\nInvalid location.\n");
        return -1;
    }

    return choice - 1;
}
//function to create request and save it in the file
int createpickuprequest(struct student *s, struct pickuprequest *request) {

    printf("\nCREATE PICKUP REQUEST\n");
    
    int roll_number;
    printf("Enter your roll number: ");
    roll_number = read_int();
    if (!findstudent(roll_number, s)) {
        printf("Student not found.\n");
        return 0;
    }
    else {
        printf("Student found: %s\n", s->name);
        printf("\nAvailable locations:\n");
        printf("1. JUIT\n");
        printf("2. Ravli PG\n");
        printf("3. Peach Tree\n");
        printf("4. Waknaghat\n");

        printf("\nEnter pickup place: ");
        scanf(" %[^\n]", request->pickup_place);

        printf("Enter dropoff place: ");
        scanf(" %[^\n]", request->dropoff_place);

        request->pickup_location = getLocationNumber(request->pickup_place);
        request->dropoff_location = getLocationNumber(request->dropoff_place);

        if (request->pickup_location == -1 || request->dropoff_location == -1) {
            printf("\nInvalid pickup or dropoff location.\n");
            return 0;
        }

        if (request->pickup_location == request->dropoff_location) {
            printf("\nPickup and dropoff cannot be the same location.\n");
            return 0;
        }
        request->direction = getDirection(request->pickup_location,request->dropoff_location);
    }
       

    //data direction
    request->student_roll_number = s->student_roll_no;
    strcpy(request->status, "PENDING_APPROVAL");
    request->bus_number = 0;
    request->request_number = getNextRequestNumber();
    printf("\nPickup request successfully created!\n");
    return 1;
}

//function to save information and pickup in a file for guard choices
void saverequest(struct pickuprequest *request) {

    //We will save the request in a file named "pendingrequest.txt" for the guard to review later.
    FILE *file;
    file = fopen("pendingrequest.txt", "a");

    //error handling if the file cannot be created
    if (file == NULL) {
        printf("\nError: Could not create request file.\n");
        return;
    }

    // we write the student and request information into the file
    fprintf(file, "%d\n", request->request_number);
    fprintf(file, "%d\n", request->student_roll_number);
    fprintf(file, "%s\n", request->pickup_place);
    fprintf(file, "%s\n", request->dropoff_place);
    fprintf(file, "%s\n", request->status);

    fclose(file);

    printf("\nRequest saved successfully.\n");
}

// ============================================================
// BUS SCHEDULING FUNCTIONS
// ============================================================

// Load buses from the schedule file. Returns the number loaded.
int loadBuses(struct bus buses[], int max) {
    FILE *f = fopen(BUS_SCHEDULE_FILE, "r");
    if (f == NULL) return 0;

    int count = 0;
    while (count < max &&
           fscanf(f, "%d %d %d %d %d",
                  &buses[count].bus_number,
                  &buses[count].route_pickup,
                  &buses[count].route_dropoff,
                  &buses[count].current_count,
                  &buses[count].max_capacity) == 5) {
        count++;
    }
    fclose(f);
    return count;
}

// Save all buses back to the schedule file.
void saveBuses(struct bus buses[], int count) {
    FILE *f = fopen(BUS_SCHEDULE_FILE, "w");
    if (f == NULL) {
        printf("\nError: Could not save bus schedule.\n");
        return;
    }
    for (int i = 0; i < count; i++) {
        fprintf(f, "%d %d %d %d %d\n",
                buses[i].bus_number,
                buses[i].route_pickup,
                buses[i].route_dropoff,
                buses[i].current_count,
                buses[i].max_capacity);
    }
    fclose(f);
}

// Get the next available bus number (one more than the highest existing).
int getNextBusNumber(void) {
    FILE *f = fopen(BUS_SCHEDULE_FILE, "r");
    if (f == NULL) return 1;

    int num, highest = 0;
    while (fscanf(f, "%d", &num) == 1) {
        if (num > highest) highest = num;
        // skip rest of line
        int c;
        while ((c = fgetc(f)) != '\n' && c != EOF);
    }
    fclose(f);
    return highest + 1;
}

// Register a new bus for a specific route.
void registerBus(void) {
    struct bus buses[MAX_BUSES];
    int count = loadBuses(buses, MAX_BUSES);

    if (count >= MAX_BUSES) {
        printf("\nMaximum number of buses (%d) reached.\n", MAX_BUSES);
        return;
    }

    struct bus newbus;
    newbus.bus_number = getNextBusNumber();
    newbus.current_count = 0;

    printf("\nREGISTER NEW BUS\n");
    printf("Bus Number: %d\n", newbus.bus_number);

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
    newbus.route_pickup = choice - 1;

    printf("Enter route dropoff location: ");
    choice = read_int();
    if (choice < 1 || choice > 4) {
        printf("\nInvalid location.\n");
        return;
    }
    newbus.route_dropoff = choice - 1;

    if (newbus.route_pickup == newbus.route_dropoff) {
        printf("\nPickup and dropoff cannot be the same location.\n");
        return;
    }

    printf("Enter bus max capacity (1-%d): ", MAX_BUS_CAPACITY);
    newbus.max_capacity = read_int();
    if (newbus.max_capacity < 1 || newbus.max_capacity > MAX_BUS_CAPACITY) {
        printf("\nInvalid capacity.\n");
        return;
    }

    buses[count] = newbus;
    saveBuses(buses, count + 1);

    char routename[80];
    getBusRouteName(&newbus, routename, sizeof(routename));
    printf("\nBus %d registered on route: %s (Capacity: %d)\n",
           newbus.bus_number, routename, newbus.max_capacity);
}

// Helper: check if a request is already assigned to any bus.
int isRequestAssigned(int request_number) {
    FILE *f = fopen(BUS_ASSIGNMENTS_FILE, "r");
    if (f == NULL) return 0;

    int req_num;
    while (fscanf(f, "%d", &req_num) == 1) {
        if (req_num == request_number) {
            fclose(f);
            return 1;
        }
        // skip rest of line (bus_number)
        int c;
        while ((c = fgetc(f)) != '\n' && c != EOF);
    }
    fclose(f);
    return 0;
}

// Assign approved (unassigned) requests to buses that match their route.
void assignRequests(void) {
    struct bus buses[MAX_BUSES];
    int busCount = loadBuses(buses, MAX_BUSES);

    if (busCount == 0) {
        printf("\nNo buses registered. Please register buses first.\n");
        return;
    }

    FILE *af = fopen("approvedrequest.txt", "r");
    if (af == NULL) {
        printf("\nNo approved requests to assign.\n");
        return;
    }

    struct pickuprequest req;
    int assigned_count = 0;

    // Read each approved request and try to assign it
    while (fscanf(af, "%d\n", &req.request_number) == 1) {
        fscanf(af, "%d\n", &req.student_roll_number);
        fgets(req.pickup_place, sizeof(req.pickup_place), af);
        fgets(req.dropoff_place, sizeof(req.dropoff_place), af);
        fgets(req.status, sizeof(req.status), af);

        req.pickup_place[strcspn(req.pickup_place, "\n")] = '\0';
        req.dropoff_place[strcspn(req.dropoff_place, "\n")] = '\0';
        req.status[strcspn(req.status, "\n")] = '\0';

        // Skip if already assigned
        if (isRequestAssigned(req.request_number))
            continue;

        // Resolve location numbers
        req.pickup_location = getLocationNumber(req.pickup_place);
        req.dropoff_location = getLocationNumber(req.dropoff_place);

        // Find a bus on the matching route with available capacity
        for (int i = 0; i < busCount; i++) {
            if (buses[i].route_pickup == req.pickup_location &&
                buses[i].route_dropoff == req.dropoff_location &&
                buses[i].current_count < buses[i].max_capacity) {

                // Assign this request to this bus
                buses[i].current_count++;

                // Record the assignment
                FILE *bf = fopen(BUS_ASSIGNMENTS_FILE, "a");
                if (bf != NULL) {
                    fprintf(bf, "%d %d\n", req.request_number, buses[i].bus_number);
                    fclose(bf);
                }

                assigned_count++;
                break;  // move to next request
            }
        }
    }

    fclose(af);

    // Save updated bus counts
    saveBuses(buses, busCount);

    if (assigned_count > 0) {
        printf("\n%d request(s) assigned to buses.\n", assigned_count);
    } else {
        printf("\nNo new requests could be assigned.\n");
        printf("Possible reasons: no buses on matching routes, or all buses are full.\n");
    }
}

// View the bus schedule with capacity and assigned requests.
void viewBusSchedule(void) {
    struct bus buses[MAX_BUSES];
    int busCount = loadBuses(buses, MAX_BUSES);

    if (busCount == 0) {
        printf("\nNo buses registered yet.\n");
        return;
    }

    printf("\n===== BUS SCHEDULE =====\n");

    for (int i = 0; i < busCount; i++) {
        char routename[80];
        getBusRouteName(&buses[i], routename, sizeof(routename));

        printf("\n-----------------------------");
        printf("\nBus Number: %d", buses[i].bus_number);
        printf("\nRoute: %s", routename);
        printf("\nCapacity: %d / %d", buses[i].current_count, buses[i].max_capacity);

        // List assigned requests for this bus
        FILE *af = fopen(BUS_ASSIGNMENTS_FILE, "r");
        if (af != NULL) {
            int req_num, bus_num;
            int found_any = 0;
            while (fscanf(af, "%d %d\n", &req_num, &bus_num) == 2) {
                if (bus_num == buses[i].bus_number) {
                    if (!found_any) {
                        printf("\nAssigned Students:");
                        found_any = 1;
                    }
                    // Look up student info
                    struct student s;
                    struct pickuprequest req;
                    // Read request details from approved file
                    FILE *rf = fopen("approvedrequest.txt", "r");
                    if (rf != NULL) {
                        while (fscanf(rf, "%d\n", &req.request_number) == 1) {
                            fscanf(rf, "%d\n", &req.student_roll_number);
                            fgets(req.pickup_place, sizeof(req.pickup_place), rf);
                            fgets(req.dropoff_place, sizeof(req.dropoff_place), rf);
                            fgets(req.status, sizeof(req.status), rf);
                            req.pickup_place[strcspn(req.pickup_place, "\n")] = '\0';
                            req.dropoff_place[strcspn(req.dropoff_place, "\n")] = '\0';
                            req.status[strcspn(req.status, "\n")] = '\0';

                            if (req.request_number == req_num) {
                                if (findstudent(req.student_roll_number, &s)) {
                                    printf("\n  - [%d] %s (Roll: %d) | %s -> %s",
                                           req.request_number, s.name,
                                           s.student_roll_no,
                                           req.pickup_place, req.dropoff_place);
                                } else {
                                    printf("\n  - [%d] Roll: %d (student not found) | %s -> %s",
                                           req.request_number, req.student_roll_number,
                                           req.pickup_place, req.dropoff_place);
                                }
                                break;
                            }
                        }
                        fclose(rf);
                    }
                }
            }
            fclose(af);
        }

        int remaining = buses[i].max_capacity - buses[i].current_count;
        printf("\nRemaining Seats: %d", remaining);
        printf("\n-----------------------------\n");
    }
}

// View capacity summary grouped by route.
void viewRouteCapacity(void) {
    struct bus buses[MAX_BUSES];
    int busCount = loadBuses(buses, MAX_BUSES);

    if (busCount == 0) {
        printf("\nNo buses registered yet.\n");
        return;
    }

    // 4 locations = up to 12 unique directional routes
    // We'll aggregate by route pair
    char *loc_names[] = {"JUIT", "Ravli PG", "Peach Tree", "Waknaghat"};

    printf("\n===== ROUTE CAPACITY SUMMARY =====\n");

    // Iterate all possible route pairs
    for (int p = 0; p < 4; p++) {
        for (int d = 0; d < 4; d++) {
            if (p == d) continue;

            int total_capacity = 0;
            int total_assigned = 0;
            int bus_count = 0;

            for (int i = 0; i < busCount; i++) {
                if (buses[i].route_pickup == p && buses[i].route_dropoff == d) {
                    total_capacity += buses[i].max_capacity;
                    total_assigned += buses[i].current_count;
                    bus_count++;
                }
            }

            if (bus_count > 0) {
                printf("\n%s -> %s", loc_names[p], loc_names[d]);
                printf("\n  Buses: %d", bus_count);
                printf("\n  Assigned: %d / %d seats", total_assigned, total_capacity);
                printf("\n  Available: %d seats", total_capacity - total_assigned);
            }
        }
    }
    printf("\n");
}

// Remove a specific assignment (unassign a student from a bus).
void unassignRequest(void) {
    int req_num;
    printf("\nUNASSIGN REQUEST FROM BUS\n");
    printf("Enter request number to unassign: ");
    req_num = read_int();

    FILE *f = fopen(BUS_ASSIGNMENTS_FILE, "r");
    if (f == NULL) {
        printf("\nNo assignments exist.\n");
        return;
    }

    // Read all assignments into memory
    int req_nums[500];
    int bus_nums[500];
    int total = 0;
    int found = 0;

    while (total < 500 && fscanf(f, "%d %d\n", &req_nums[total], &bus_nums[total]) == 2) {
        if (req_nums[total] == req_num) found = 1;
        total++;
    }
    fclose(f);

    if (!found) {
        printf("\nRequest %d is not assigned to any bus.\n", req_num);
        return;
    }

    // Write back without the matching entry, and decrement bus count
    FILE *wf = fopen(BUS_ASSIGNMENTS_FILE, "w");
    struct bus buses[MAX_BUSES];
    int busCount = loadBuses(buses, MAX_BUSES);

    int written = 0;
    for (int i = 0; i < total; i++) {
        if (req_nums[i] == req_num) {
            // Decrement the bus count
            for (int b = 0; b < busCount; b++) {
                if (buses[b].bus_number == bus_nums[i] && buses[b].current_count > 0) {
                    buses[b].current_count--;
                    break;
                }
            }
            continue;  // skip writing this entry
        }
        fprintf(wf, "%d %d\n", req_nums[i], bus_nums[i]);
        written++;
    }
    fclose(wf);

    saveBuses(buses, busCount);
    printf("\nRequest %d has been unassigned from its bus.\n", req_num);
}

// Bus Scheduler Portal
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
        }
        else if (choice == 2) {
            assignRequests();
        }
        else if (choice == 3) {
            viewBusSchedule();
        }
        else if (choice == 4) {
            viewRouteCapacity();
        }
        else if (choice == 5) {
            unassignRequest();
        }
        else if (choice == 6) {
            printf("\nExiting Bus Scheduler Portal...\n");
            break;
        }
        else {
            printf("\nInvalid choice. Try again.\n");
        }
    }
}

// ============================================================
// END BUS SCHEDULING FUNCTIONS
// ============================================================

void guardportal(void) {

    //Guard portal function to read the request from the file and display it to the guard for approval or rejection.
    FILE *file;
    FILE *temporary_file;
    FILE *studentapprovedfile;
    FILE *studentrejectedfile;

    struct student s;
    struct pickuprequest request;

    file = fopen("pendingrequest.txt", "r");

    //error handling
    if (file == NULL) {
        printf("\nNo request available right now!\n");
        return;
    }
    temporary_file = fopen("temporary_file.txt", "w");
    if  (temporary_file == NULL) {
        printf("\nError creating temporary file.\n");
        fclose(file);
        return;
    }

    while (fscanf(file, "%d\n", &request.request_number) == 1) {
        fscanf(file, "%d\n", &request.student_roll_number);
        fgets(request.pickup_place, sizeof(request.pickup_place), file);
        fgets(request.dropoff_place, sizeof(request.dropoff_place), file);
        fgets(request.status, sizeof(request.status), file);
        request.pickup_place[strcspn(request.pickup_place, "\n")] = '\0';
        request.dropoff_place[strcspn(request.dropoff_place, "\n")] = '\0';
        request.status[strcspn(request.status, "\n")] = '\0';

        if (request.student_roll_number == 0) {
            printf("\nInvalid student roll number in request.\n");
            fprintf(temporary_file, "%d\n", request.request_number);
            fprintf(temporary_file, "%d\n", request.student_roll_number);
            fprintf(temporary_file, "%s\n", request.pickup_place);
            fprintf(temporary_file, "%s\n", request.dropoff_place);
            fprintf(temporary_file, "%s\n", request.status);
            continue;
        }

        if (!findstudent(request.student_roll_number, &s)) {
            printf("\nStudent with roll number %d not found.\n", request.student_roll_number);

            fprintf(temporary_file, "%d\n", request.request_number);
            fprintf(temporary_file, "%d\n", request.student_roll_number);
            fprintf(temporary_file, "%s\n", request.pickup_place);
            fprintf(temporary_file, "%s\n", request.dropoff_place);
            fprintf(temporary_file, "%s\n", request.status);

            continue;
        }
        
        //Request Panel with relevant student requesting pickup
        printf("GUARD PORTAL\n");
        printf("\nStudent Name: %s", s.name);
        printf("\nRoll Number: %d", s.student_roll_no);
        printf("\nHostel: %s", s.hostel_name);
        printf("\nRoom Number: %s", s.room_number);
        printf("\nPhone Number: %s", s.phone_number);
        printf("\n\nPickup Place: %s", request.pickup_place);
        printf("\nDropoff Place: %s", request.dropoff_place);
        printf("\nRequest Status: %s\n", request.status);

        //Choices of the guard before physical verification
        int guard_choice;
        printf("\n1. Approve Request");
        printf("\n2. Reject Request");
        printf("\nEnter your choice: ");
        guard_choice = read_int();

        if (guard_choice == 1) {
            strcpy(request.status, "APPROVED");

            studentapprovedfile = fopen("approvedrequest.txt", "a");
            if (studentapprovedfile == NULL) {
                printf("\nError: Could not create approved request file.\n");
                continue;
            }
            else {
                fprintf(studentapprovedfile, "%d\n", request.request_number);
                fprintf(studentapprovedfile, "%d\n", request.student_roll_number); 
                fprintf(studentapprovedfile, "%s\n", request.pickup_place);
                fprintf(studentapprovedfile, "%s\n", request.dropoff_place);
                fprintf(studentapprovedfile, "%s\n", request.status);
                fclose(studentapprovedfile);
            }
            printf("\nYour Request has been APPROVED.\n");
            
        }
        else if (guard_choice == 2) 
        {
            strcpy(request.status, "REJECTED");
            studentrejectedfile = fopen("rejectedrequest.txt", "a");
            if (studentrejectedfile == NULL) {
                printf("\nError: Could not create rejected request file.\n");
                continue;}
            fprintf(studentrejectedfile, "%d\n",request.request_number);
            fprintf(studentrejectedfile, "%d\n",request.student_roll_number);
            fprintf(studentrejectedfile, "%s\n",request.pickup_place);
            fprintf(studentrejectedfile, "%s\n",request.dropoff_place);
            fprintf(studentrejectedfile, "%s\n",request.status);
            fclose(studentrejectedfile);
            printf("\nRequest has been REJECTED.\n");
        }
        else {
            printf("\nInvalid choice.\n");
            printf("Request will remain pending.\n");
            fprintf(temporary_file, "%d\n",request.request_number);
            fprintf(temporary_file, "%d\n",request.student_roll_number);
            fprintf(temporary_file, "%s\n",request.pickup_place);
            fprintf(temporary_file, "%s\n",request.dropoff_place);
            fprintf(temporary_file, "%s\n",request.status);
        }
    }

    fclose(file);
    fclose(temporary_file);
    if (remove("pendingrequest.txt") != 0) 
    {
        printf("\nError removing old pending request file.\n");
        return;
    }
    if (rename("temporary_file.txt", "pendingrequest.txt") != 0) 
    {
        printf("\nError updating pending request file.\n");
    }
    else
    {
        printf("\nAll requests have been processed.\n");
    }

}
void viewrequests(char filename[], char title[]){
    FILE *file;
    struct student s;
    struct pickuprequest request;

    file = fopen(filename, "r");

    if (file == NULL)
    {
        printf("\nNo %s available.\n", title);
        return;
    }

    printf("\n===== %s =====\n", title);

    // Load bus assignments for display
    FILE *bf = fopen(BUS_ASSIGNMENTS_FILE, "r");
    int assign_reqs[500], assign_buses[500];
    int assign_count = 0;
    if (bf != NULL) {
        while (assign_count < 500 &&
               fscanf(bf, "%d %d\n", &assign_reqs[assign_count], &assign_buses[assign_count]) == 2) {
            assign_count++;
        }
        fclose(bf);
    }

    while (fscanf(file, "%d\n", &request.request_number) == 1)
    {
        fscanf(file, "%d\n", &request.student_roll_number);

        fgets(request.pickup_place, sizeof(request.pickup_place), file);
        fgets(request.dropoff_place, sizeof(request.dropoff_place), file);
        fgets(request.status, sizeof(request.status), file);

        request.pickup_place[strcspn(request.pickup_place, "\n")] = '\0';
        request.dropoff_place[strcspn(request.dropoff_place, "\n")] = '\0';
        request.status[strcspn(request.status, "\n")] = '\0';

        if (!findstudent(request.student_roll_number, &s))
        {
            printf("\nStudent record not found for Roll Number: %d\n",
                   request.student_roll_number);
            continue;
        }

        printf("\n-----------------------------");
        printf("\nRequest Number: %d", request.request_number);
        printf("\nStudent Name: %s", s.name);
        printf("\nRoll Number: %d", s.student_roll_no);
        printf("\nHostel: %s", s.hostel_name);
        printf("\nRoom Number: %s", s.room_number);
        printf("\nPhone Number: %s", s.phone_number);
        printf("\nPickup Place: %s", request.pickup_place);
        printf("\nDropoff Place: %s", request.dropoff_place);
        printf("\nStatus: %s", request.status);

        // Show bus assignment if applicable
        for (int a = 0; a < assign_count; a++) {
            if (assign_reqs[a] == request.request_number) {
                printf("\nBus Number: %d", assign_buses[a]);
                break;
            }
        }

        printf("\n-----------------------------\n");
    }

    fclose(file);
}
void studentrequeststatus(void){
    int roll_number;
    int found = 0;

    printf("\nCHECK REQUEST STATUS");
    printf("\nEnter your roll number: ");
    roll_number = read_int();
    FILE *pendingfile = fopen("pendingrequest.txt", "r");

    if (pendingfile != NULL)
    {
        struct pickuprequest request;

        while (fscanf(pendingfile, "%d\n", &request.request_number) == 1)
        {
            fscanf(pendingfile, "%d\n", &request.student_roll_number);

            fgets(request.pickup_place, sizeof(request.pickup_place), pendingfile);
            fgets(request.dropoff_place, sizeof(request.dropoff_place), pendingfile);
            fgets(request.status, sizeof(request.status), pendingfile);

            request.pickup_place[strcspn(request.pickup_place, "\n")] = '\0';
            request.dropoff_place[strcspn(request.dropoff_place, "\n")] = '\0';
            request.status[strcspn(request.status, "\n")] = '\0';

            if (request.student_roll_number == roll_number)
            {
                printf("\n-----------------------------");
                printf("\nRequest Number: %d", request.request_number);
                printf("\nPickup: %s", request.pickup_place);
                printf("\nDropoff: %s", request.dropoff_place);
                printf("\nStatus: %s", request.status);
                printf("\n-----------------------------\n");

                found = 1;
            }
        }

        fclose(pendingfile);
    }

    FILE *approvedfile = fopen("approvedrequest.txt", "r");

    if (approvedfile != NULL)
    {
        struct pickuprequest request;

        while (fscanf(approvedfile, "%d\n", &request.request_number) == 1)
        {
            fscanf(approvedfile, "%d\n", &request.student_roll_number);

            fgets(request.pickup_place, sizeof(request.pickup_place), approvedfile);
            fgets(request.dropoff_place, sizeof(request.dropoff_place), approvedfile);
            fgets(request.status, sizeof(request.status), approvedfile);

            request.pickup_place[strcspn(request.pickup_place, "\n")] = '\0';
            request.dropoff_place[strcspn(request.dropoff_place, "\n")] = '\0';
            request.status[strcspn(request.status, "\n")] = '\0';

            if (request.student_roll_number == roll_number)
            {
                printf("\nRequest Number: %d", request.request_number);
                printf("\nPickup: %s", request.pickup_place);
                printf("\nDropoff: %s", request.dropoff_place);
                printf("\nStatus: %s", request.status);

                // Show bus assignment
                FILE *bf = fopen(BUS_ASSIGNMENTS_FILE, "r");
                if (bf != NULL) {
                    int rn, bn;
                    while (fscanf(bf, "%d %d\n", &rn, &bn) == 2) {
                        if (rn == request.request_number) {
                            printf("\nBus Number: %d", bn);
                            break;
                        }
                    }
                    fclose(bf);
                }

                printf("\n");
                found = 1;
            }
        }

        fclose(approvedfile);
    }

    FILE *rejectedfile = fopen("rejectedrequest.txt", "r");

    if (rejectedfile != NULL)
    {
        struct pickuprequest request;

        while (fscanf(rejectedfile, "%d\n", &request.request_number) == 1)
        {
            fscanf(rejectedfile, "%d\n", &request.student_roll_number);

            fgets(request.pickup_place, sizeof(request.pickup_place), rejectedfile);
            fgets(request.dropoff_place, sizeof(request.dropoff_place), rejectedfile);
            fgets(request.status, sizeof(request.status), rejectedfile);

            request.pickup_place[strcspn(request.pickup_place, "\n")] = '\0';
            request.dropoff_place[strcspn(request.dropoff_place, "\n")] = '\0';
            request.status[strcspn(request.status, "\n")] = '\0';

            if (request.student_roll_number == roll_number)
            {
                printf("\nRequest Number: %d", request.request_number);
                printf("\nPickup: %s", request.pickup_place);
                printf("\nDropoff: %s", request.dropoff_place);
                printf("\nStatus: %s\n", request.status);

                found = 1;
            }
        }

        fclose(rejectedfile);
    }

    if (!found)
    {
        printf("\nNo processed requests found for Roll Number %d.\n", roll_number);
    }
}
void studentportal(void){
    struct student current_student;
    struct pickuprequest current_request;
    int choice;

    while (1)
    {
        printf("\nSTUDENT PORTAL");
        printf("\n1. Register Student");
        printf("\n2. Create Pickup Request");
        printf("\n3. Check Request Status");
        printf("\n4. Exit Student Portal");
        printf("\nEnter your choice: ");
        choice = read_int();
        if (choice == 1){
            studentregistration(&current_student);
        }
        else if (choice == 2){
            if (createpickuprequest(&current_student, &current_request)){
                saverequest(&current_request);
            }
        }
        else if (choice == 3){
            studentrequeststatus();
        }
        else if (choice == 4){
            printf("\nExiting Student Portal...\n");
            break;
        }
        else {
            printf("\nInvalid choice. Try again.\n");
        }
    }
}
void guardmenu(void){
    int choice;
    while (1)
    {
        printf("\nGUARD PORTAL");
        printf("\n1. Process Pending Requests");
        printf("\n2. View Approved Requests");
        printf("\n3. View Rejected Requests");
        printf("\n4. Exit Guard Portal");
        printf("\nEnter your choice: ");

        choice = read_int();

        if (choice == 1){
            guardportal();
        }
        else if (choice == 2){
            viewrequests("approvedrequest.txt", "APPROVED REQUESTS");
        }
        else if (choice == 3){
            viewrequests("rejectedrequest.txt", "REJECTED REQUESTS");
        }
        else if (choice == 4){
            printf("\nExiting Guard Portal...\n");
            break;
        }
        else{
            printf("\nInvalid choice. Try again.\n");
        }
    }
}

int main() {
    int choice;
    while (1) {
        printf("\n========================================");
        printf("\n       JUIT SMART SHUTTLE");
        printf("\n========================================");
        printf("\n1. Student Portal");
        printf("\n2. Guard Portal");
        printf("\n3. Bus Scheduler Portal");
        printf("\n4. Exit");
        printf("\nEnter your choice: ");
        choice = read_int();

        if (choice == 1) {
            studentportal();
        }
        else if (choice == 2) {
            guardmenu();
        }
        else if (choice == 3) {
            busSchedulerPortal();
        }
        else if (choice == 4) {
            printf("\nExiting JUIT Smart Shuttle\n");
            break;
        }
        else {
            printf("\nInvalid choice.\n");
        }
    }

    return 0;
}
