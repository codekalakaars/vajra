# Tasks

## Purpose

This section is the conceptual documentation for the task model — what a task is, how work is structured into phases and groups, how it moves through its lifecycle, and the rules governing scheduling and completion.

## Table of Contents

- [What a Task Is](#what-a-task-is)
- [Anatomy of a Task](#anatomy-of-a-task)
- [Phases](#phases)
- [Verification Ladder](#verification-ladder)
- [Task Groups](#task-groups)
- [Parallel Order](#parallel-order)
- [The limit is a ceiling, and the ceiling belongs to the host](#the-limit-is-a-ceiling-and-the-ceiling-belongs-to-the-host)
- [Two Kinds of Ordering](#two-kinds-of-ordering)
- [Task States](#task-states)
- [Task Lifecycle](#task-lifecycle)
- [Task Dependencies](#task-dependencies)
- [Task Scheduling Rules](#task-scheduling-rules)
- [Task Completion Rules](#task-completion-rules)
- [A completed task is not automatically a verified one](#a-completed-task-is-not-automatically-a-verified-one)
- [Failure Containment](#failure-containment)

## What a Task Is

A task is the **atomic unit of work** in Vajra. It is the smallest self-contained unit — there are no sub-tasks, and a task is either executed whole or not at all.

Two conditions must hold before a task may be created:

1. **Testable** — the target files are known, and the success criteria are defined.
2. **End-to-end** — a single Worker can complete it without further decomposition.

A task that fails either condition is not ready. The Developer refines it first.

Because a task is atomic, there is no parent/child relationship and no sub-tasks. Work that would once have been a sub-task — writing tests for an implementation, for example — is simply its own task, related by a [dependency](#task-dependencies).

## Anatomy of a Task

Every task carries:

| Element | Purpose |
|---------|---------|
| **Identity** | Unique identifier, used in all messages about the task |
| **Description** | What the Worker must do, sufficient to act on without asking questions |
| **Target files** | Exact paths the Worker may modify. The Worker creates any that do not exist yet |
| **Success criteria** | The conditions that determine completion |
| **Verification ladder** | Which ladder rungs apply and how each is run. See [Verification Ladder](#verification-ladder) |
| **Review rounds** | How many `changes_requested` rounds the Manager may use before it must reject |
| **Phase** | Which phase of the submission the task belongs to |
| **Group** | Which parallel group within the phase |
| **State** | Where the task is in its lifecycle |
| **Assignment** | Which Worker is executing it, if any |
| **Dependencies** | Tasks *in the same group* that must complete first |
| **Priority** | Ordering against tasks *in other groups* that share a file |
| **Provenance** | Whether the task came from Human direction or a Manager escalation |

Formal field definitions live in [Task Specification](../specifications/task-spec.md).

## Phases

A **phase** is a sequential stage of the submission. Phases run one after another; work within a phase may run in parallel.

```
Submission
├── maxParallelGroups: 3
│
├── Phase 1 — core
│   ├── group: schema
│   └── group: config        ordered after "schema"
│
├── Phase 2 — features
│   ├── group: auth
│   ├── group: session
│   └── group: audit-log     priority-ordered against "auth" (shared file)
│
└── Phase 3 — integration
    └── group: e2e           depends on the phase above
```

The hierarchy has four levels, each with one job:

| Level | Sequencing | Parallelism |
|-------|-----------|-------------|
| **Submission** | — | bounded by `maxParallelGroups` |
| **Phase** | strictly sequential | — |
| **Group** | `groupOrder` | parallel, within the limit |
| **Task** | `dependsOn` | parallel, within the group |

This gives each level exactly one ordering mechanism. Phases order stages, `groupOrder` orders groups inside a phase, `dependsOn` orders tasks inside a group, and `priority` resolves file collisions anywhere. See [Two Kinds of Ordering](#two-kinds-of-ordering).

No phase is special. A submission may have one phase or several, and the first phase is ordinary work like any other. The mandatory Phase One of stubs and failing tests was removed by [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

**Assumption:** Phases are a flat ordered list, not a tree. Nested phases are not supported — a submission with more structure than "ordered stages" should be split into multiple submissions.

## Verification Ladder

Every task is verified by a **verification ladder**. The Manager's mechanical part runs it after the Worker reports completion. The rungs are climbed in order, and the ladder stops at the first rung that fails. See [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

| Rung | Question | Typical evidence | Tier |
|------|----------|------------------|------|
| 1. **Compiles** | Does the changed code build or type-check? | `tsc --noEmit`, `cargo check`, `go build`, a bundler build | 2 — structural |
| 2. **Runs** | Does it start without crashing? | The entry point, script, or binary runs to a clean exit or reaches ready | 2 — structural |
| 3. **Dependencies** | Does it work against the services it needs? | Each database or external service is stubbed, or confirmed reachable and healthy | 2 — structural, unless its checks assert behaviour |
| 4. **Serves** | If it is a server, does it start and answer correctly? | Server started on a free port, readiness probed, probes asserted. See [Testing APIs Directly](../testing/README.md#testing-apis-directly) | 1 — behavioural, when probes assert behaviour |
| 5. **Tests** | Do the project's relevant tests pass? | Selected tests from the project's own runner, ingested as JUnit XML or TAP | 1 — behavioural, when tests assert behaviour |

### Who declares what

- **The Developer declares the ladder for each task**: which rungs apply, and how each is run — the build command, the run command, the services the task depends on, the server and its probes, and the tests.
- **A rung that does not apply is declared not applicable, with a reason.** A pure library has no rung 4; a script with no tests has no rung 5.
- **At least one rung must apply.** A task whose ladder is entirely not applicable is invalid, for the same reason a task whose criteria are all `review` is invalid.

### Rules of the ladder

- **Every rung expects `pass`.** Each rung produces a structured verdict under the [verdict contract](../adr/0007-test-verdict-contract.md); `flaky`, `timeout` and `failed_environment` never satisfy a rung.
- **Rung 3 means stubbed or checked, never assumed.** A service that is neither stubbed nor confirmed healthy fails rung 3 as `failed_environment`.
- **Tests are optional work, not a gate.** Writing tests is ordinary work the Developer may plan as its own tasks. When tests exist for the changed code, rung 5 runs them.
- **A failing test is written on purpose only when declared.** A task explicitly declared as writing a test for missing behaviour (`writesFailingTest: true`) expects its test to fail on an assertion. No other task does.

**Assumption:** the Manager's mechanical verifier provisions the stubs and runs the health checks for rung 3. The Developer declares the dependencies; Workers do not write service stubs unless the Developer planned that as a task.

### Why a ladder

Each rung is only worth checking once the one below it holds, and each one that fails says where the problem is: "does not compile", "crashes on start", "database stub missing" and "probe returned 500" are different problems with different fixes. A task that cannot be verified stalls itself and what depends on it, not the whole submission.

## Task Groups

A **group** is the unit of parallelism within a phase. The Developer partitions each phase's tasks into groups at submission; the Manager does not invent the partition.

- Tasks in the same group are intended to run **concurrently**.
- Groups within a phase may also run concurrently, bounded by the parallelism limit.
- Every task belongs to exactly one group.

Grouping is a planning decision, not a runtime discovery. The Developer already knows which work is independent — a login form and a password reset page do not touch the same files and can safely run at once. Encoding that as groups means the Manager never has to guess at independence.

## Parallel Order

The order in which work runs is **predefined by the Developer**, not inferred at runtime.

Four things are declared up front:

| Declared | Level | Answers |
|----------|-------|---------|
| **Phases** | submission | What must finish before what? |
| **`groupOrder`** | phase | Which group starts first? |
| **Dependencies** | group | Must this task wait? |
| **Priority** | any | Which of two colliding tasks first? |

The parallelism limit — how many groups may be in flight at once — is also predefined.

**Assumption:** The parallelism limit is a property of the submission rather than a global system setting, because it is a planning decision: the Developer knows whether the work suits two Workers or ten. The alternative is a deployment-level cap that bounds every session, which is simpler but removes the Developer's control.

A task is eligible when its phase is active, its group is active, its in-group dependencies are `completed`, and no higher-priority task holds a file it needs.

### The limit is a ceiling, and the ceiling belongs to the host

Two different questions get confused here, and they are answered in different places:

| Question | Answered by | Changing it |
|----------|-------------|-------------|
| How much of this work is independent? | The Developer, at submission | Re-planning the submission |
| How many Workers can this machine carry? | The host, at runtime | Machine load, or an explicit override |

The Developer declares **how much parallelism the work admits** — the shape of the plan. The harness enforces **how much the host can carry** — the ceiling. The Manager is not involved in either: assignment, locking and admission are deterministic code, because a model in that loop would make the same plan schedule differently and would put liveness beyond reasoning. See [ADR-0005](../adr/0005-predefined-parallel-order.md) and [ADR-0011](../adr/0011-tiered-success-criteria.md).

The ceiling is **derived from the machine, not fixed at a constant**, and it moves with load:

- It rises when the host is idle and falls when the host is busy, bounded below by one Worker so a run always makes progress.
- It is overridable, because the harness cannot know what else the machine is doing.
- **Degrading under load is always available to the harness; crashing the host is not.** When the two conflict, the host wins.

**Assumption:** the ceiling is reported alongside the results rather than applied silently. A run that took 40 seconds because the machine was busy is not comparable to one that took 40 seconds on an idle host, and a report that does not say which it was cannot support a regression claim against the harness itself.

```
Submission
  Phase 1
    group "schema" = [define user schema]
    group "config" = [add session config]         ordered after "schema"
  Phase 2
    group "auth"   = [implement auth]
    group "session"= [implement session]
    group "audit"  = [implement audit]  shares auth.ts with "auth" → priority

maxParallelGroups: 2

t=0   Phase 1: "schema" starts. "config" waits — groupOrder.
t=1   "schema" verified and accepted. "config" starts.
t=2   "config" verified and accepted. Phase 1 done.
t=3   Phase 2: "auth" and "session" start. "audit" waits on priority.
t=4   "auth" accepted, its Worker killed, auth.ts released → "audit" starts.
```

The idle slot while a lower-priority task waits is the cost of file-overlap priority: correctness outranks utilisation.

## Two Kinds of Ordering

The model separates two things that are easy to conflate.

| | **Dependencies** | **Priority** |
|---|---|---|
| Scope | Within a group | Between groups or phases |
| Question answered | Must this wait? | Which of these two first? |
| Set by | Developer | Developer |
| Basis | Logical correctness — the result is meaningless out of order | File overlap — two tasks touching one file cannot run together |
| Enforced by | Manager refuses to assign | Manager orders, and file ownership serialises |

Both are needed. A dependency expresses *logical* sequence; priority expresses *resource* contention. A task can depend on another with no file overlap at all, and two tasks can overlap files with no logical dependency.

Phases and `groupOrder` sit above both, expressing stage ordering that is neither logical dependency nor file contention — it is simply "this groundwork comes first".

## Task States

| State | Meaning | Set by |
|-------|---------|--------|
| `draft` | Defined by the Developer but not yet approved by the Human | Developer |
| `pending` | Approved and awaiting assignment | Developer |
| `assigned` | Handed to a Worker, not yet started | Manager |
| `in_progress` | Actively being executed | Worker |
| `frozen` | Paused, with its state saved, waiting for a file another task owns | Manager |
| `verifying` | The Worker has claimed completion; the ladder and the Manager's review are running | Worker's `task.complete` |
| `completed` | The ladder passed and the Manager agent accepted the work | Manager |
| `failed` | Execution ended without meeting success criteria | Worker |
| `rejected` | The Manager agent rejected the work, or review rounds ran out | Manager |
| `blocked` | Cannot proceed and requires Developer input | Worker or Manager |

`failed`, `rejected` and `blocked` are terminal. The Developer answers each, with the Human, by creating a new task.

**Assumption:** `rejected` and `blocked` are modelled as distinct states because they have different owners — a rejection is closed by the Developer creating a remediation task, whereas a block is answered by the Developer revising or splitting the original task. Simplify if this distinction is not worth carrying.

## Task Lifecycle

```
  ┌───────┐ approve ┌─────────┐ assign ┌──────────┐ start
  │ draft │────────▶│ pending │───────▶│ assigned │───────┐
  └───────┘         └─────────┘        └──────────┘       │
      ▲                                                   ▼
      │                      freeze          ┌─────────────┐   task.fail    ┌────────┐
      │         ┌────────┐◀──────────────────│             │───────────────▶│ failed │
      │         │ frozen │                   │ in_progress │                └────────┘
      │         └────────┘──────────────────▶│             │  task.blocked  ┌─────────┐
      │             │         resume         └─────────────┘───────────────▶│ blocked │
      │             │                            │       ▲                  └─────────┘
      │             │ wait timeout               │       │                       ▲
      │             └────────────────────────────┼───────┼───────────────────────┘
      │                            task.complete │       │ changes_requested
      │                                          ▼       │ (rounds left)
      │                                     ┌───────────┐│
      │                                     │ verifying │┘
      │                                     └───────────┘
      │                            accepted  │         │  rejected, or
      │                                      ▼         ▼  rounds exhausted
      │                             ┌───────────┐ ┌──────────┐
      │                             │ completed │ │ rejected │
      │                             └───────────┘ └──────────┘
      │                             Worker killed  Worker killed
      │
      └── failed, rejected, blocked: escalated; the Developer, with the Human, creates a new task
```

A Worker's `task.complete` is a claim, and it moves the task to `verifying`. The Manager's mechanical part runs the [ladder](#verification-ladder), then the Manager agent reviews the result and gives one of three verdicts. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

| Verdict | Task becomes | What happens |
|---------|--------------|--------------|
| `accepted` | `completed` | The Worker is killed, its files are released, and dependent tasks are released |
| `changes_requested` | `in_progress` | Findings go to the same Worker, which keeps its context and tries again. The review round goes up by one |
| `rejected` | `rejected` | The Worker is killed and the task is escalated to the Developer |

The `changes_requested` loop is bounded by the task's `maxReviewRounds`. When the rounds are used up, the next verdict that is not `accepted` is `rejected`. **Assumption:** the default is two rounds, so a task gets three attempts in total.

A task moves to `frozen` when the Manager answers an access request for a file another task owns with `freeze`. It returns to `in_progress` when the file is released and access is granted. A frozen task that waits past its task timeout becomes `blocked` and is escalated. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

The Manager never repairs work and never creates follow-up tasks. Findings say what is wrong, not how to fix it. Anything that ends in `failed`, `rejected` or `blocked` goes to the Developer, and only the Developer produces follow-up work. See [ADR-0001](../adr/0001-developer-only-task-creation.md).

A failure also holds back anything sequenced behind it: in-group [dependencies](#task-dependencies), later groups in the same phase, and all later phases. See [Parallel Order](#parallel-order).

## Task Dependencies

A task may declare `dependsOn` — the set of tasks that must **complete successfully** before it becomes assignable.

- Dependencies are **intra-group only**. A dependency never crosses a group boundary — use `groupOrder` within a phase, or a later phase, for anything wider.
- Dependencies are set by the **Developer** at creation, from knowledge of the codebase.
- The **Manager** respects dependencies when assigning, and may not assign a task whose dependencies are unmet.
- Dependencies are **ordering only**. A dependency does not grant access to another task's files — each task's permissions remain scoped to its own target files and any access grants it received. A completed task may publish a structured handoff that dependent Workers can read through the Manager's peer view.

Only `completed` satisfies a dependency. A failed, rejected, or blocked dependency leaves its dependents unassignable, because work built on an unfinished or failed foundation is not sound — building on a schema change that was rejected would produce a meaningless result.

The consequence is that one failure **stalls what depends on it, not the whole queue**. Independent groups and phases continue normally. The stall resolves when the Developer acts on the escalation and the dependency eventually completes.

## Task Scheduling Rules

1. **The Manager executes the plan; it does not build one.** Phases, grouping, dependencies, and priority are all declared by the Developer. The Manager's scheduling is a traversal of that plan, not an optimisation.
2. **The Manager assigns; Workers never self-schedule.** A Worker with no assignment is idle and waits.
3. **One task per Worker.** A Worker holds at most one non-terminal task at a time, including while it is `frozen`. See [ADR-0002](../adr/0002-single-task-workers.md).
4. **Dependencies first.** A task is assignable only when every task it depends on is `completed`.
5. **Priority over file overlap.** Where two tasks in different groups or phases share a file, the higher-priority one goes first, and the other waits. See [File Ownership](../permissions/README.md#file-ownership).
6. **Permissions follow assignment.** A Worker's access is provisioned for the assigned task, widened only by a recorded access grant, and withdrawn when the task reaches a terminal state. The Worker is killed at its task's verdict. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).
7. **The parallelism limit is a ceiling, not a target.** The Manager runs as many groups as the limit allows, but never exceeds it.

## Task Completion Rules

A task is `completed` only when all of the following hold:

1. Every declared target file has been addressed.
2. Execution stayed within the task's file scope — its `targetFiles` plus any files granted to it during the task. No other file was modified.
3. The Worker reported completion with evidence for each criterion.
4. Every applicable rung of the [verification ladder](#verification-ladder) passed. For a task declared `writesFailingTest`, its test fails on an assertion rather than passing or erroring.
5. The Manager agent reviewed the ladder verdicts and evidence, the diff, the Worker's report and the success criteria, and gave the verdict `accepted`.

**The mechanical floor binds the Manager agent.** It may reject work the ladder passed. It may never accept work the ladder failed: a task whose ladder did not pass can only get `changes_requested` or `rejected`.

The Worker reporting success is a claim, not a verdict — the Manager holds the verdict. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

### A completed task is not automatically a verified one

Completion and verification are different states, and a task earns them separately.

A task whose criteria and applicable rungs are all **tier 2** is verified **structurally**: the change exists, is wired in, and is well-formed, and nothing more. A task with at least one **tier 1** criterion or rung is verified **behaviourally**: the behaviour it claims to produce was shown to hold. On the ladder, rungs 1–3 are structural and rungs 4–5 are behavioural when their probes or tests assert behaviour.

Every task clears the mechanical floor — at least one ladder rung must apply (see [Validation Rules](../specifications/task-spec.md#validation-rules)), and a task whose criteria are all `review` is rejected outright. But the floor is a floor, not a ceiling, and it is met at different heights. The distinction is a **reporting** obligation, and it is not optional: a submission that reports a tier 2 pass and a tier 1 pass both as "passed" has reintroduced exactly the false pass that [ADR-0007](../adr/0007-test-verdict-contract.md) exists to prevent.

So the final report to the Human distinguishes them — every task names the **highest rung it reached**, and a task verified structurally says so and names what it established. A task that only compiled is never reported as tested. A whole submission built on tier 2 is a real, useful result and is not a fully tested one. See [Criterion Tiers](../specifications/task-spec.md#criterion-tiers) and [ADR-0011](../adr/0011-tiered-success-criteria.md).

## Failure Containment

**A task's failure is contained to that task and to whatever depends on it.**

A Worker that crashes, hangs, is killed, or exhausts memory fails **its** task. The failure is attributed, escalated through the Manager, and the submission continues. Three things must not happen, because each of them would let one bad task destroy work that already succeeded:

| Must not | Why |
|----------|-----|
| Abort the submission | A runaway loop or an OOM in one Worker would be able to discard the whole run |
| Fail unrelated tasks | Blast radius stops at the task, exactly as it does for a file |
| Cancel siblings | A failure is evidence about one task, not about the plan |

Independence is what makes this safe: a task depends only on what it declared, and an unrelated task has no reason to care. A Worker pool absorbs the loss by leasing a fresh Worker for the next task, so a crash costs latency rather than capacity.

A crash is not a review round. The bounded `changes_requested` loop applies only to work that reached `verifying`.

## See Also

- [Task Specification](../specifications/task-spec.md)
- [System Roles](../system-roles/README.md)
- [Execution](../execution/README.md)
- [Permissions](../permissions/README.md)
- [Testing](../testing/README.md)
- [ADR-0005 — Predefined Parallel Order](../adr/0005-predefined-parallel-order.md)
- [ADR-0006 — Phase One Is Mandatory](../adr/0006-phase-one-is-mandatory.md) (superseded by ADR-0012)
- [ADR-0012 — A Verification Ladder Replaces Phase One](../adr/0012-verification-ladder-replaces-phase-one.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](../adr/0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](../adr/0014-peer-aware-workers-and-access-requests.md)
