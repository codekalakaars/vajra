# Communication

## Purpose

This section documents how the roles communicate — the channels that exist, the messages that flow on them, and the shape of those messages.

## Table of Contents

- [Communication Model](#communication-model)
- [Channels](#channels)
- [Message Types](#message-types)
- [Event Flow](#event-flow)
- [Invariants](#invariants)

## Communication Model

Vajra uses a **hub topology**. The Manager is the hub; every Worker connects only to it.

```
Human ◀──────▶ Developer ◀──────▶ Manager ◀──────▶ Worker
                                     ▲                │
                                     └────────────────┘
```

Messages flow in three directions:

- **Downward** — task submission and task assignment.
- **Upward** — completion reports and escalations.
- **Nowhere else** — there is no lateral channel. Workers never address the Human or Developer, and the Manager never relays instructions it did not receive from the Developer.

**Assumption:** The Human communicates with the Developer through the same channel as everything else rather than a distinct out-of-band interface.

## Channels

| Channel | From | To | Carries |
|---------|------|----|---------|
| `dev-mgr` | Developer | Manager | Task submission |
| `mgr-dev` | Manager | Developer | Status reports, escalations |
| `mgr-wrk` | Manager | Worker | Task assignment |
| `wrk-mgr` | Worker | Manager | Progress, completion, failure, blocks |

Message shapes are defined in [Protocol](protocol.md).

## Message Types

### Developer → Manager

| Type | Purpose |
|------|---------|
| `task.submit` | Submit a finalized batch of tasks for orchestration |
| `task.withdraw` | Remove a task that has not yet been assigned |

### Manager → Developer

| Type | Purpose |
|------|---------|
| `status.report` | Periodic or on-demand progress across the task set |
| `escalation.report` | A task failed, was rejected at inspection, or is blocked |
| `escalation.resolved` | Acknowledgement that a remediation task was created |

### Manager → Worker

| Type | Purpose |
|------|---------|
| `task.assign` | Assign one task, with its scoped permissions |
| `task.cancel` | Withdraw a task before it completes |

### Worker → Manager

| Type | Purpose |
|------|---------|
| `task.accept` | Confirm the assignment was understood |
| `task.progress` | Interim status, no scope change |
| `task.complete` | Execution finished, with evidence per success criterion |
| `task.fail` | Execution ended without meeting success criteria |
| `task.blocked` | Cannot proceed; needs Developer input |

**Assumption:** A Worker cannot change the scope of its task through any message. If a Worker discovers the task is wrong, it reports `task.blocked` and waits. Scope changes require the Developer to issue a new task.

## Event Flow

The steady-state cycle, per task:

```
Developer  task.submit ──────────▶ Manager   (plan: tasks, groups, limit, priority)
                                      │ activates groups within the parallelism limit
                                      │ selects task, checks eligibility
                                      │ provisions permissions
Manager    task.assign ───────────▶ Worker
                                      │ executes end to end
Worker     task.progress ─────────▶ Manager   (optional, any number)
Worker     task.complete ────────▶ Manager
                                      │ withdraws permissions
                                      │ releases file ownership
                                      │ inspects against success criteria
Manager    status.report ─────────▶ Developer
```

The corrective path, when inspection fails:

```
Worker     task.complete ────────▶ Manager
                                      │ inspection fails
Manager    escalation.report ────▶ Developer
                                      │ decides: revise / remediate / abandon
Developer  task.submit ──────────▶ Manager   (new task)
```

## Invariants

These hold for every message and are worth stating because they are what make the model safe:

1. **A Worker is never addressed by the Developer or Human.** All Worker communication is mediated by the Manager.
2. **No message expands a Worker's scope.** Scope originates in a task, and only the Developer writes tasks.
3. **Every task-scoped message names a task.** A Worker with no current assignment is idle and expects nothing.
4. **Reports are claims, verdicts are the Manager's.** A `task.complete` does not mean the task is closed; only inspection does that.
5. **Escalation is one-directional.** The Manager escalates to the Developer and does not wait on a reply that bypasses the task flow — the answer is a new task.

## See Also

- [Protocol](protocol.md)
- [System Roles](../system-roles/README.md)
- [Execution](../execution/README.md)
- [Task Specification](../specifications/task-spec.md)
