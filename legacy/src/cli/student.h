#ifndef CLI_STUDENT_H
#define CLI_STUDENT_H

#include "src/core/models.h"

// Student-facing CLI: registration, portal, request creation, status view.

void studentregistration(struct student *s);
int  findstudent(int roll_number, struct student *s);
void createAndSaveRequest(struct student *s);
void studentrequeststatus(int roll_number);
void studentportal(struct student *current_student);

#endif // CLI_STUDENT_H
