# Manager

## Purpose

This document describes the Manager role — task assignment, worker supervision, verification, review, access requests, and escalation responsibilities.

## Table of Contents

- [Manager Agent](#manager-agent)
- [Task Assignment](#task-assignment)
- [Worker Supervision](#worker-supervision)
- [Verification and Review](#verification-and-review)
- [Access Requests](#access-requests)
- [Escalation Responsibilities](#escalation-responsibilities)
- [Constraints](#constraints)

## Manager Agent

The Manager is the orchestrator of the system. It receives all tasks from the Developer, assigns them to Workers, verifies and reviews the results, and escalates problems back to the Developer. It never talks to the Human.

The Manager has two parts. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

| Part | What it is | What it does |
|------|-----------|--------------|
| Mechanical | Deterministic code | Scheduling, admission and the parallelism ceiling; permission provisioning and withdrawal; file ownership; supervision; running the verification ladder; recording access grants; freezing and resuming Workers; deadlock detection; killing Workers |
| LLM | The Manager agent | Reviews ladder verdicts and evidence, the diff, the Worker's report and the success criteria, and gives the verdict; decides access requests |

The mechanical part establishes facts and makes no judgement calls. The Manager agent judges, and does not decide which task runs next.

## Task Assignment

- Receive all tasks from the Developer.
- Assign one task at a time to each Worker.
- Ensure each Worker has the permissions and context needed for their assigned task, including the read-only peer view: the project goal, the plan's other tasks, each task's status and holder, the files each active task owns, and handoffs from completed tasks. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

## Worker Supervision

- Monitor Worker progress on assigned tasks.
- Ensure Workers complete their tasks end to end.
- Kill every Worker at the end of its task, whether the verdict is `accepted` or `rejected`, and withdraw its permissions. No Worker outlives its task's verdict.

## Verification and Review

When a Worker reports completion, the task moves to `verifying`.

1. **The mechanical part runs the verification ladder** the Developer declared: compiles, runs, dependencies, serves, tests. It stops at the first failing rung and records the highest rung reached. See [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).
2. **The Manager agent reviews** the ladder's verdicts and evidence, the diff, the Worker's report and the task's success criteria, and gives one verdict:

| Verdict | What happens |
|---------|--------------|
| `accepted` | Task becomes `completed`. The Worker is killed, its files are released, and dependent tasks are released |
| `changes_requested` | The Worker is killed and the task is respawned with a fresh Worker, which gets the task unchanged, the last checkpoint, and the findings. Task returns to `in_progress` and its respawn count goes up by one. See [ADR-0016](../adr/0016-failed-attempts-are-respawned.md) and [ADR-0019](../adr/0019-a-retry-is-told-what-failed-and-a-finished-task-hands-off.md) |
| `rejected` | Task becomes `rejected`. The Worker is killed and the task is escalated to the Developer |

- **Mechanical floor.** The Manager agent may reject work the ladder passed. It may never accept work the ladder failed.
- **Bounded respawns.** Each task allows 2 respawns, so three Workers in total. When they run out, the next non-accepting verdict is `rejected`.
- **Findings, not fixes.** Findings state what is wrong. They do not contain a fix to apply.
- **The respawn gets the evidence, not the reasoning.** The failed attempt's conversation is never passed on. What is passed is its outcome, the command that failed with its output, its last checkpoint, and the diff of what it tried — the record the runtime kept, not the reasoning the model produced. A Worker shown its own mistake in context defends it; a Worker shown the evidence of it can reconsider.

**Assumption:** the mechanical part provisions service stubs and runs health checks for the dependencies rung. Workers do not write service stubs unless the Developer planned that as a task.

## Access Requests

A Worker may ask for a file outside its task. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

1. The mechanical part checks whether another active task owns the file.
2. The Manager agent decides:
   - **File is free:** `granted` (the file joins the task's scope for the rest of the task, and the task takes ownership) or `denied` (the Worker proceeds without it).
   - **File is owned:** `not_needed` (proceed without it, with an explanation), `freeze` (the Worker saves its state and pauses; it resumes with access when the file is released), or `continue_meanwhile` (the Worker keeps working on parts that do not need the file; access is granted when the file is released).
3. The mechanical part enforces the decision.

Limits that hold regardless of the decision:

- One writer per file. An owned file is never granted; waiting is the only path to it.
- A freeze that would create a wait cycle is refused. The Manager agent must choose another response or escalate.
- A frozen Worker past its task timeout is escalated, and its task becomes `blocked`.
- Every grant is recorded and attributed, in the audit log and in the task's review.
- Grants never create work. A request that implies new work is escalated to the Developer.
- A grant lasts only for the task that received it.

## Escalation Responsibilities

- When a task is `rejected` or `failed`, or a Worker is blocked, the Manager escalates to the Developer.
- The Manager does not fix problems directly — it reports them so the Developer, with the Human, can decide what to do.

## Constraints

- Cannot create tasks.
- Cannot execute tasks.
- Cannot write code or modify Worker output — only verify, review and report.
- Cannot accept work the ladder failed.
- Cannot grant a file another active task owns.
- Cannot talk to the Human.

## See Also

- [Developer](developer.md)
- [Worker](worker.md)
- [Execution](../execution/README.md)
- [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)
