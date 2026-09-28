# Execution

## Purpose

This section documents how work moves through the system — from Developer to Manager to Worker — including parallel execution, validation, and failure recovery.

## Table of Contents

- [Developer → Manager Flow](#developer--manager-flow)
- [Phase One Execution](#phase-one-execution)
- [Manager → Worker Flow](#manager--worker-flow)
- [Parallel Execution](#parallel-execution)
- [The Manager spawns; it does not decide how many](#the-manager-spawns-it-does-not-decide-how-many)
- [Validation Flow](#validation-flow)
- [Failure Recovery](#failure-recovery)

## Developer → Manager Flow

The Developer is the sole source of work. It never bypasses the Manager.

1. The Human states a requirement to the Developer.
2. The Developer defines the tasks — target files, success criteria — and structures them into phases.
3. The Developer builds **Phase One**: stub-file tasks, then test tasks that are expected to fail.
4. The Human finalizes the tasks.
5. The Developer submits the plan to the Manager as a single `task.submit`, carrying phases, tasks, and `maxParallelGroups`.
6. The Manager runs Phase One to completion.
7. Only then does the Manager begin the next phase, and repeats until the submission is exhausted.
8. The Developer receives `status.report` and `escalation.report` throughout.

**Assumption:** The plan is submitted as a batch rather than task by task. Phases, grouping, and the parallelism limit are properties of the whole submission, so they cannot be expressed incrementally. See [ADR-0005](../adr/0005-predefined-parallel-order.md) and [ADR-0006](../adr/0006-phase-one-is-mandatory.md).

## Phase One Execution

Phase One runs first and gates everything after it.

```
Phase One
  group "stubs"   create src/auth.ts, create src/session.ts
  group "tests"   write test for auth, write test for session   [after stubs]
```

- Stub tasks are ordinary tasks whose success criterion is that the declared path exists, is syntactically valid, and exports the expected symbols.
- Test tasks are ordinary tasks whose success criterion is that the test is **collected and fails on an assertion**. A test that errors on import has not demonstrated anything and fails the criterion.
- No later phase starts until every Phase One task is `completed`.

This gate is what makes the rest of the submission executable: after it, each implementation task reduces to making an already-failing test pass.

## Manager → Worker Flow

Per task, the Manager runs this loop:

1. Confirm the task's phase is active — Phase One before anything else — and its group is active within the parallelism limit and `groupOrder`.
2. Confirm in-group dependencies are `completed` and no higher-priority task holds a shared file.
3. Select an idle Worker.
4. Provision task-scoped permissions.
5. Assign the task (`task.assign`).
6. Supervise — observe progress reports while the Worker executes.
7. Receive the outcome report (`task.complete`, `task.fail`, or `task.blocked`).
8. Withdraw permissions and release file ownership.
9. Inspect the output against the success criteria.
10. Report the verdict upward, then return to step 1.

The Manager makes no attempt to influence how the Worker accomplishes the task. It governs *whether* and *when*, not *how* — and it does not adjust the plan it was given, even when the plan is suboptimal. See [ADR-0005](../adr/0005-predefined-parallel-order.md).

## Parallel Execution

Parallelism is horizontal across Workers, never within one.

- Each Worker executes exactly one task at a time. Parallelism comes from having multiple Workers on different tasks.
- **Phases are sequential.** Parallelism lives inside a phase, never across phases.
- **Groups define what may run together.** The Developer partitions the work; the Manager does not infer independence.
- **The parallelism limit is a ceiling.** The Manager runs as many groups as it allows, and starts a group only when a slot is free.
- **File ownership is the backstop.** Where the plan is wrong — two tasks in the same group sharing a file with no dependency between them — file ownership serialises them anyway. Validation catches this at submission, but the ownership rule holds regardless.
- **Priority resolves cross-group collisions.** Where two tasks in different groups or phases share a file, the higher-priority one runs first.

A group slot can sit idle while a lower-priority task waits on a collision, and Phase One can leave most of the queue idle while a single test group runs. Both are intentional: correctness and the gate outrank utilisation.

**Assumption:** Groups are scheduled in declaration order when several are eligible. There is no attempt to pick the group that would unblock the most downstream work.

### The Manager spawns; it does not decide how many

The Manager is responsible for Workers coming into existence and for their output being judged. It is **not** responsible for deciding how many run at once. Assignment, file locking and admission are deterministic code, for two reasons: a traversal of a declared plan has a provably correct answer that a model would only make probabilistic, and a model in that loop would put liveness beyond reasoning. See [ADR-0005](../adr/0005-predefined-parallel-order.md).

So the count is mechanical, and the ceiling it obeys is the **host's**, not a constant and not the Developer's. The Developer declares how much of the work is independent; the machine decides how much of that it can carry at once; the harness reduces the count under load rather than failing. Degrading is always available to the harness and crashing the host is not, so when the two conflict the host wins. See [The limit is a ceiling](../tasks/README.md#the-limit-is-a-ceiling-and-the-ceiling-belongs-to-the-host) and [ADR-0011](../adr/0011-tiered-success-criteria.md).


## Validation Flow

Validation is layered, and each layer is owned by a different role:

| Layer | Owner | Question answered |
|-------|-------|-------------------|
| Task definition | Developer | Is success defined before work starts? |
| Criterion tier | Developer | Is the proof behavioural, structural, or a judgement? |
| Phase One gate | Developer, verified by Manager | Does the work exist as a failing test before implementation? |
| Self-check | Worker | Did I meet my own success criteria? |
| Inspection | Manager | Does the output actually satisfy them? |
| Confirmation | Human | Is this what I asked for? |

The Worker's self-check is reported, not trusted. The Manager's inspection is the operative verdict, because the Manager is the only role that both defined no part of the task and wrote none of the code.

`test`- and `assertion`-type criteria are judged **mechanically**, not by reading the diff. The testing system produces a structured verdict, and the expectation is inverted for Phase One tasks — where a failing test is the objective. See [Testing](../testing/README.md) and [ADR-0007](../adr/0007-test-verdict-contract.md).

`review`-type criteria remain a judgement call, and are documented as such. They are **additive, never sufficient**: a task whose criteria are all `review` is rejected at submission, because nothing about it could be established mechanically. See [Criterion Tiers](../specifications/task-spec.md#criterion-tiers).

**Assumption:** A Worker that changes only files outside its declared scope is rejected automatically, before inspection.

## Failure Recovery

There is no automatic retry. Recovery is always routed through the Developer.

```
Worker fails or blocks
        │
        ▼
Manager reports to Developer  ── escalation.report
        │
        ▼
Developer decides:
  ├── revise the original task  ──▶ new task, same scope, corrected criteria
  ├── create a remediation task ──▶ new task addressing the reported problem
  └── abandon                  ──▶ task closed, no further work
        │
        ▼
Developer submits to Manager ── cycle repeats
```

The Manager holds no authority to retry, re-scope, or repair. It reports what it observed and stops.

### A crash costs one task

A Worker that crashes, hangs, is killed, or exhausts memory fails **its own task** and nothing else. The failure is attributed and escalated as normal; the submission continues. It must not abort the run, fail unrelated tasks, or cancel siblings — each of those would let one bad task destroy work that already succeeded, and blast radius stops at the task exactly as it does for a file.

Independence is what makes containment cheap: a task depends only on what it declared, so an unrelated task has no reason to care what happened elsewhere. A pool of Workers absorbs the loss by leasing a fresh one for the next task, so the cost of a crash is latency rather than capacity. See [Failure Containment](../tasks/README.md#failure-containment) and [ADR-0011](../adr/0011-tiered-success-criteria.md).

**Assumption:** There is no retry ceiling enforced by the system. If escalating loops become a problem in practice, a limit will need to be added — most likely on the Developer, since it is the only role that can decide whether to keep going.

## See Also

- [Tasks](../tasks/README.md)
- [System Roles](../system-roles/README.md)
- [Communication](../communication/README.md)
- [Permissions](../permissions/README.md)
- [Testing](../testing/README.md)
