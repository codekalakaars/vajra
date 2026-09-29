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

The Human talks only to the Developer. Every plan, and every plan revision, is approved by the Human before the Developer submits it, and the Human approves or rejects the final results.

Messages flow in three directions:

- **Downward** — task submission, task assignment, review findings, access decisions, and the read-only team view.
- **Upward** — completion reports, access requests, handoffs, and escalations.
- **Nowhere else** — there is no lateral channel. Workers never address each other, the Human, or the Developer, and the Manager never relays instructions it did not receive from the Developer.

Workers are peer-aware, but only through the hub ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)). A Worker asks the Manager for a read-only view of the run (`team.query` → `team.status`): the other tasks, their status and holders, the files each active task owns, and handoffs from completed tasks. It never sees another Worker's conversation or intermediate edits, and it cannot message another Worker.

**Assumption:** The Human communicates with the Developer through the same channel as everything else rather than a distinct out-of-band interface.

## Channels

| Channel | From | To | Carries |
|---------|------|----|---------|
| `dev-mgr` | Developer | Manager | Task submission, plan revisions, withdrawal |
| `mgr-dev` | Manager | Developer | Status reports, escalations |
| `mgr-wrk` | Manager | Worker | Task assignment, review feedback, access decisions, resume, team view |
| `wrk-mgr` | Worker | Manager | Progress, completion, failure, blocks, access requests, team queries, handoffs |

Message shapes are defined in [Protocol](protocol.md).

## Message Types

### Developer → Manager

| Type | Purpose |
|------|---------|
| `task.submit` | Submit a Human-approved batch of tasks, or a Human-approved plan revision, for orchestration |
| `task.withdraw` | Remove a task that has not yet been assigned |

### Manager → Developer

| Type | Purpose |
|------|---------|
| `status.report` | Periodic or on-demand progress across the task set |
| `escalation.report` | A task failed, was rejected at review (including exhausted review rounds), or is blocked (including a freeze timeout or an access request that implies new work) |
| `escalation.resolved` | Acknowledgement that a remediation task was created |

### Manager → Worker

| Type | Purpose |
|------|---------|
| `task.assign` | Assign one task, with its scoped permissions |
| `task.cancel` | Withdraw a task before it completes |
| `review.feedback` | `changes_requested`: the Manager agent's findings, the round, and the ladder result; the same Worker tries again |
| `access.decision` | The answer to an `access.request`: `granted`, `denied`, `not_needed`, `freeze`, or `continue_meanwhile` |
| `task.resume` | Resume a frozen task, or deliver a file released to a task that continued meanwhile, with the files now granted |
| `team.status` | Read-only view of the run: tasks, states, owned files, handoffs |

Killing a Worker is not a message. The Manager's mechanical part terminates the Worker process when its task is `accepted` or `rejected`, and records the kill in the audit log ([ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md)).

### Worker → Manager

| Type | Purpose |
|------|---------|
| `task.accept` | Confirm the assignment was understood |
| `task.progress` | Interim status, no scope change |
| `task.complete` | Execution finished, with evidence per success criterion. A claim; the task moves to `verifying` |
| `task.fail` | Execution ended without meeting success criteria |
| `task.blocked` | Cannot proceed; needs Developer input |
| `access.request` | Ask for a file outside the task, with mode and reason |
| `team.query` | Ask for the current read-only view of the run |
| `task.handoff` | Publish a structured handoff for the Worker's own task, visible to peers |

A Worker cannot widen its own scope through any message. It can ask with `access.request`, and its scope grows only if the Manager records a `granted` decision ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)). A grant never creates work. If a Worker discovers the task itself is wrong, or that it needs work belonging to another task, it reports `task.blocked` and the Developer decides, with the Human.

## Event Flow

The steady-state cycle, per task. The Manager's mechanical part runs the [verification ladder](../adr/0012-verification-ladder-replaces-phase-one.md); the Manager agent reviews the result and gives the verdict ([ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md)):

```
Human      approves plan ────────▶ Developer
Developer  task.submit ──────────▶ Manager   (plan: tasks, ladders, groups, limit, priority)
                                      │ activates groups within the parallelism limit
                                      │ selects task, checks eligibility
                                      │ provisions permissions, takes file ownership
Manager    task.assign ───────────▶ Worker
                                      │ executes end to end
Worker     task.progress ─────────▶ Manager   (optional, any number)
Worker     task.handoff ──────────▶ Manager   (optional)
Worker     task.complete ────────▶ Manager   (task → verifying)
                                      │ mechanical: runs the ladder, rung by rung,
                                      │   stopping at the first failing rung
                                      │ agent: reviews ladder verdicts, evidence, diff,
                                      │   Worker report, success criteria, access grants
                                      │ verdict: accepted (never over a ladder fail)
                                      │ task → completed
                                      │ kills the Worker, withdraws permissions,
                                      │   releases file ownership, releases dependents
Manager    status.report ─────────▶ Developer
```

The review loop, when the work is close:

```
Worker     task.complete ────────▶ Manager   (task → verifying)
                                      │ ladder runs; agent reviews
                                      │ verdict: changes_requested (rounds remain)
Manager    review.feedback ──────▶ Worker    (task → in_progress, round + 1;
                                      │          same Worker, context kept, files kept)
                                      │ Worker addresses the findings
Worker     task.complete ────────▶ Manager   (task → verifying)
                                      │ ... until accepted, or rejected
```

The corrective path, when the verdict is `rejected` (including exhausted review rounds):

```
Worker     task.complete ────────▶ Manager
                                      │ ladder runs; agent reviews
                                      │ verdict: rejected (task → rejected)
                                      │ kills the Worker, withdraws permissions,
                                      │   releases file ownership
Manager    escalation.report ────▶ Developer
                                      │ decides with the Human:
                                      │   revise / remediate / abandon
Developer  task.submit ──────────▶ Manager   (new task, Human-approved)
```

The access request path:

```
Worker     access.request ───────▶ Manager   (file, mode, reason)
                                      │ mechanical: is the file owned by another active task?
                                      │
                                      ├─ free: agent decides
Manager    access.decision ──────▶ Worker    granted (recorded; scope and ownership widened)
                                      │        or denied (proceed without it)
                                      │
                                      └─ owned: agent decides
Manager    access.decision ──────▶ Worker    not_needed (proceed without it)
                                      │        or continue_meanwhile (keep working)
                                      │        or freeze (task → frozen; Worker saves state)
                                      │          refused if it would create a wait cycle
                                      │
                                      │ ... owning task reaches a terminal state,
                                      │     file released, grant recorded
Manager    task.resume ──────────▶ Worker    (grantedFiles; frozen → in_progress)
                                      │
                                      │ if a frozen task waits past its timeout:
                                      │   task → blocked
Manager    escalation.report ────▶ Developer
```

A request that implies new work is not granted; it is escalated to the Developer as `blocked`.

## Invariants

These hold for every message and are worth stating because they are what make the model safe:

1. **A Worker is never addressed by the Developer or Human.** All Worker communication is mediated by the Manager.
2. **Scope expands only through a recorded `access.decision`.** Scope originates in a task, and only the Developer writes tasks. The only message that widens a Worker's scope is an `access.decision` of `granted` (or the `task.resume` that follows a wait), and only after the grant is recorded. A grant never gives a file another active task owns, and never creates work.
3. **Every task-scoped message names a task.** A Worker with no current assignment is idle and expects nothing.
4. **Reports are claims, verdicts are the Manager agent's, bounded by the ladder.** A `task.complete` does not close a task; it moves it to `verifying`. Only the Manager agent's verdict closes it, and the agent may never accept a task whose ladder failed.
5. **Escalation is one-directional.** The Manager escalates to the Developer and does not wait on a reply that bypasses the task flow — the answer is a new task.

## See Also

- [Protocol](protocol.md)
- [ADR-0012 — A Verification Ladder Replaces Phase One](../adr/0012-verification-ladder-replaces-phase-one.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](../adr/0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](../adr/0014-peer-aware-workers-and-access-requests.md)
- [Permissions](../permissions/README.md)
- [System Roles](../system-roles/README.md)
- [Execution](../execution/README.md)
- [Task Specification](../specifications/task-spec.md)
