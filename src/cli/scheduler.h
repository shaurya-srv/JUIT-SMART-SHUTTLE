#ifndef CLI_SCHEDULER_H
#define CLI_SCHEDULER_H

// Bus-scheduler-facing CLI: bus registration, assignment trigger, reports.

void registerBus(void);
void assignRequests(void);
void unassignRequest(void);
void busSchedulerPortal(void);

#endif // CLI_SCHEDULER_H
