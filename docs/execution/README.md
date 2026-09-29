# Execution

## Purpose

This section documents how work moves through the system — from Developer to Manager to Worker — including parallel execution, validation, and failure recovery.

## Table of Contents

- [Developer → Manager Flow](#developer--manager-flow)
- [Ladder Execution](#ladder-execution)
- [Manager → Worker Flow](#manager--worker-flow)
- [Access Requests and Freezing](#access-requests-and-freezing)
- [Parallel Execution](#parallel-execution)
- [The Manager spawns; it does not decide how many](#the-manager-spawns-it-does-not-decide-how-many)
- [Validation Flow](#validation-flow)
- [Failure Recovery](#failure-recovery)

## Developer → Manager Flow

The Developer is the sole source of work. It never bypasses the Manager, and it acts only on its conversation with the Human and the Human's approval.

1. The Human states a requirement to the Developer.
2. The Developer defines the tasks — target files, success criteria, and a [verification ladder](../tasks/README.md#verification-ladder) for each — and structures them into phases and groups.
3. The Human approves the plan. Nothing is submitted without that approval.
4. The Developer submits the plan to the Manager as a single `task.submit`, carrying phases, tasks, and `maxParallelGroups`.
5. The Manager runs the phases in order until the submission is exhausted.
6. The Developer receives `status.report` and `escalation.report` throughout, and stays available while the run is active.
7. A new request from the Human during the run becomes a plan revision. The Human approves it before it is submitted, and it never changes a task that is already `assigned` or `in_progress`.
8. The Human approves or rejects the final results, through the Developer.

The Developer does not modify files and does not create stub files. A declared target file that does not exist yet is created by the Worker whose task owns it. There is no mandatory first phase: Phase One was removed by [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

**Assumption:** The plan is submitted as a batch rather than task by task. Phases, grouping, and the parallelism limit are properties of the whole submission, so they cannot be expressed incrementally. See [ADR-0005](../adr/0005-predefined-parallel-order.md).

## Ladder Execution

When a Worker reports `task.complete`, the task moves to `verifying` and the Manager's mechanical part runs the task's verification ladder. It climbs the rungs in order and stops at the first one that fails.

```
task.complete
  1. compile        tsc --noEmit                        pass
  2. run            node dist/cli.js --help             pass
  3. dependencies   postgres: stub started              pass
  4. serve          start on free port, probe /login    fail  ── stop here
  5. tests          (not run)
highest rung reached: 3
```

- Only the rungs the Developer declared as applicable run. A rung declared not applicable is recorded with its reason.
- Every rung expects `pass`, and produces a structured verdict with evidence under the [verdict contract](../adr/0007-test-verdict-contract.md).
- For rung 3, each declared service is either stubbed or health-checked. A service that is neither fails the rung as `failed_environment`.
- The result names the highest rung reached. It goes to the Manager agent for review, and later into the report to the Human.

**Assumption:** the mechanical verifier provisions the stubs and runs the health checks for rung 3. Workers do not write service stubs unless the Developer planned that as a task.

## Manager → Worker Flow

The Manager has two parts. The **mechanical part** is deterministic code: scheduling, permissions, file ownership, supervision, the ladder, access grants, freezing, and killing Workers. The **LLM part** is the Manager agent: it reviews results, gives verdicts, and decides access requests. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

Per task, the Manager runs this loop:

1. Confirm the task's phase is active, and its group is active within the parallelism limit and `groupOrder`.
2. Confirm in-group dependencies are `completed` and no higher-priority task holds a shared file.
3. Select an idle Worker.
4. Provision task-scoped permissions and take ownership of the task's files.
5. Assign the task (`task.assign`).
6. Supervise — observe progress reports, answer `team.query` with the peer view, and handle access requests while the Worker executes.
7. Receive the outcome report (`task.complete`, `task.fail`, or `task.blocked`).
8. On `task.complete`, move the task to `verifying` and run the [ladder](#ladder-execution).
9. The Manager agent reviews the ladder verdicts and evidence, the diff, the Worker's report, any access grants, and the success criteria, and gives a verdict:
   - `accepted` — the task becomes `completed`.
   - `changes_requested` — the findings go to the same Worker as `review.feedback`. The task returns to `in_progress`, the review round goes up by one, and the loop continues from step 6.
   - `rejected` — the task becomes `rejected` and is escalated to the Developer.
10. On a terminal state, kill the Worker, withdraw permissions, and release file ownership. A Worker never outlives its task's verdict.
11. Report upward, release dependent tasks if the task was accepted, then return to step 1.

**The mechanical floor binds the Manager agent.** It may reject work the ladder passed. It may never accept work the ladder failed.

**Review rounds are bounded** by the task's `maxReviewRounds`. When they run out, the next verdict that is not `accepted` is `rejected`. **Assumption:** the default is two rounds, so a task gets three attempts in total.

The Manager makes no attempt to influence how the Worker accomplishes the task. Its findings state what is wrong, not the fix. It governs *whether* and *when*, not *how* — and it does not adjust the plan it was given, even when the plan is suboptimal. See [ADR-0005](../adr/0005-predefined-parallel-order.md).

## Access Requests and Freezing

Workers are peer-aware through the Manager. A Worker can ask for a read-only view of the run — the project goal, the other tasks, their states and holders, the files each active task owns, and handoffs from completed tasks. It cannot see peers' conversations or intermediate edits, and cannot message a peer. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

A Worker that needs a file outside its task sends `access.request` with the file and a reason. The mechanical part checks whether another active task owns the file, and the Manager agent decides:

| File is | Possible decisions | What happens |
|---------|--------------------|--------------|
| Free | `granted` | The file joins the task's scope for the rest of the task, and the task takes ownership of it |
| Free | `denied` | The Worker proceeds without it |
| Owned by another task | `not_needed` | The Worker proceeds without it; the Manager explains why |
| Owned by another task | `freeze` | The Worker saves its state and the task becomes `frozen`. When the file is released, the task resumes (`task.resume`) with access granted |
| Owned by another task | `continue_meanwhile` | The Worker keeps working on parts that do not need the file; the file is granted when released |

Limits hold regardless of the decision:

- One writer per file, always. Waiting is the only path to an owned file.
- A freeze that would create a wait cycle is refused, and the Manager agent must choose another response or escalate.
- A frozen task that waits past its task timeout becomes `blocked` and is escalated.
- Every grant is recorded and attributed, appears in the audit log, and is shown in the task's review.
- A grant never creates work. A request that implies new work is escalated to the Developer.
- A grant lasts only for the task that received it.

## Parallel Execution

Parallelism is horizontal across Workers, never within one.

- Each Worker executes exactly one task at a time. Parallelism comes from having multiple Workers on different tasks.
- **Phases are sequential.** Parallelism lives inside a phase, never across phases.
- **Groups define what may run together.** The Developer partitions the work; the Manager does not infer independence.
- **The parallelism limit is a ceiling.** The Manager runs as many groups as it allows, and starts a group only when a slot is free.
- **File ownership is the backstop.** Where the plan is wrong — two tasks in the same group sharing a file with no dependency between them — file ownership serialises them anyway. Validation catches this at submission, but the ownership rule holds regardless.
- **Priority resolves cross-group collisions.** Where two tasks in different groups or phases share a file, the higher-priority one runs first.

A group slot can sit idle while a lower-priority task waits on a collision, or while a frozen Worker waits for a file. Both are intentional: correctness outranks utilisation.

**Assumption:** Groups are scheduled in declaration order when several are eligible. There is no attempt to pick the group that would unblock the most downstream work.

### The Manager spawns; it does not decide how many

The Manager is responsible for Workers coming into existence and for their output being judged. It is **not** responsible for deciding how many run at once. Assignment, file locking and admission are deterministic code, for two reasons: a traversal of a declared plan has a provably correct answer that a model would only make probabilistic, and a model in that loop would put liveness beyond reasoning. See [ADR-0005](../adr/0005-predefined-parallel-order.md).

So the count is mechanical, and the ceiling it obeys is the **host's**, not a constant and not the Developer's. The Developer declares how much of the work is independent; the machine decides how much of that it can carry at once; the harness reduces the count under load rather than failing. Degrading is always available to the harness and crashing the host is not, so when the two conflict the host wins. See [The limit is a ceiling](../tasks/README.md#the-limit-is-a-ceiling-and-the-ceiling-belongs-to-the-host) and [ADR-0011](../adr/0011-tiered-success-criteria.md).


## Validation Flow

Validation is layered, and each layer is owned by a different role:

| Layer | Owner | Question answered |
|-------|-------|-------------------|
| Task definition | Developer, approved by Human | Is success, and the ladder that checks it, defined before work starts? |
| Criterion tier | Developer | Is the proof behavioural, structural, or a judgement? |
| Self-check | Worker | Did I meet my own success criteria? Reported, not trusted |
| Verification ladder | Manager (mechanical part) | Does it compile, run, work against its services, serve, and pass its tests? |
| Review | Manager (LLM part) | Does the output, with its ladder evidence, actually satisfy the task? |
| Confirmation | Human, via the Developer | Is this what I asked for? |

The Worker's self-check is reported, not trusted. The ladder establishes facts, and the Manager agent judges them. The Manager's verdict is the operative one, because the Manager is the only role that both defined no part of the task and wrote none of the code. It may reject a ladder pass, but never accept a ladder fail.

`test`- and `assertion`-type criteria, and every ladder rung, are judged **mechanically**, not by reading the diff. The testing system produces a structured verdict. Every rung expects `pass`; the expectation is inverted only for a task declared `writesFailingTest`, whose objective is a test that fails on an assertion. See [Testing](../testing/README.md), [ADR-0007](../adr/0007-test-verdict-contract.md) and [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

`review`-type criteria remain a judgement call, and are documented as such. They are **additive, never sufficient**: a task whose criteria are all `review` is rejected at submission, because nothing about it could be established mechanically. See [Criterion Tiers](../specifications/task-spec.md#criterion-tiers).

**Assumption:** A Worker that changes only files outside its scope — `targetFiles` plus its access grants — is rejected automatically, before review.

## Failure Recovery

Recovery has two stages. A task that is close gets bounded review rounds with the same Worker. Anything else goes to the Developer.

```
Worker reports task.complete
        │
        ▼
Ladder + Manager agent review
        │
        ├── accepted ─────────────▶ completed, Worker killed
        │
        ├── changes_requested ────▶ review.feedback to the same Worker
        │   (rounds left)            (keeps its context, tries again)
        │
        └── rejected, or rounds exhausted
                │
                ▼
        Worker killed ── escalation.report to Developer

Worker fails or blocks, or a frozen task times out
        │
        ▼
Manager reports to Developer  ── escalation.report
        │
        ▼
Developer decides, with the Human:
  ├── revise the original task  ──▶ new task, same scope, corrected criteria
  ├── create a remediation task ──▶ new task addressing the reported problem
  └── abandon                  ──▶ task closed, no further work
        │
        ▼
Developer submits to Manager ── cycle repeats
```

Inside the review loop, the Manager's findings say what is wrong, not how to fix it. Outside it, the Manager holds no authority to create tasks, re-scope beyond a recorded access grant, or repair. It reports what it observed and stops. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

### A crash costs one task

A Worker that crashes, hangs, is killed, or exhausts memory fails **its own task** and nothing else. The failure is attributed and escalated as normal; the submission continues. It must not abort the run, fail unrelated tasks, or cancel siblings — each of those would let one bad task destroy work that already succeeded, and blast radius stops at the task exactly as it does for a file.

Independence is what makes containment cheap: a task depends only on what it declared, so an unrelated task has no reason to care what happened elsewhere. A pool of Workers absorbs the loss by leasing a fresh one for the next task, so the cost of a crash is latency rather than capacity. See [Failure Containment](../tasks/README.md#failure-containment) and [ADR-0011](../adr/0011-tiered-success-criteria.md).

A crash is not a review round. It fails the task and goes to the Developer.

**Assumption:** The review loop is bounded by `maxReviewRounds`, but the Developer's escalation loop is not. If repeated escalations of the same work become a problem in practice, a limit will need to be added — most likely on the Developer, since it is the only role that can decide, with the Human, whether to keep going.

## See Also

- [Tasks](../tasks/README.md)
- [System Roles](../system-roles/README.md)
- [Communication](../communication/README.md)
- [Permissions](../permissions/README.md)
- [Testing](../testing/README.md)
- [ADR-0012 — A Verification Ladder Replaces Phase One](../adr/0012-verification-ladder-replaces-phase-one.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](../adr/0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](../adr/0014-peer-aware-workers-and-access-requests.md)
