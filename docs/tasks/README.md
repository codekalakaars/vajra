# Tasks

## Purpose

This section is the conceptual documentation for the task model — what a task is, how work is structured into phases and groups, how it moves through its lifecycle, and the rules governing scheduling and completion.

## Table of Contents

- [What a Task Is](#what-a-task-is)
- [Anatomy of a Task](#anatomy-of-a-task)
- [Phases](#phases)
- [Phase One](#phase-one)
- [Task Groups](#task-groups)
- [Parallel Order](#parallel-order)
- [Two Kinds of Ordering](#two-kinds-of-ordering)
- [Task States](#task-states)
- [Task Lifecycle](#task-lifecycle)
- [Task Dependencies](#task-dependencies)
- [Task Scheduling Rules](#task-scheduling-rules)
- [Task Completion Rules](#task-completion-rules)

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
| **Target files** | Exact paths the Worker may modify |
| **Success criteria** | The conditions that determine completion |
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
├── Phase 1 — Phase One  (mandatory)
│   ├── group: stubs
│   └── group: tests          ordered after "stubs"
│
├── Phase 2 — implementation
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

**Assumption:** Phases are a flat ordered list, not a tree. Nested phases are not supported — a submission with more structure than "ordered stages" should be split into multiple submissions.

## Phase One

**Phase One is mandatory.** Every submission begins with it, and no later phase may start until it completes.

Phase One contains exactly two kinds of work:

| Work | What it produces | Why it must come first |
|------|-----------------|-------------------------|
| **Stub files** | Every `targetFiles` path exists, minimal but syntactically valid | A test cannot be written against a file that does not exist |
| **Tests** | A runnable test per behaviour, currently failing | Success criteria become executable before any implementation exists |

Phase One is ordered internally — stubs, then tests:

```typescript
groupOrder: [["stubs"], ["tests"]]
```

### Why This Gate Exists

Phase One converts a task set from a description of intent into something mechanically checkable.

- **Success criteria become executable before implementation starts.** A test that exists and fails is a precise definition of "done". Without it, "does it work?" is a judgement call; with it, the answer is a command's exit code.
- **Every target path is guaranteed to exist.** A Worker never has to decide whether to create a file or which path to use — both were settled before it started.
- **Discovery stops at the gate.** Questions that would otherwise surface mid-implementation, when they are expensive, surface in Phase One, when the only cost is a stub.

The result is that the Worker's job narrows to making a failing test pass, which is the one task with an unambiguous definition of success.

### What Completes Phase One

A Phase One task is complete when:

| Task type | Success criterion |
|-----------|-------------------|
| **Stub** | The file exists at the exact declared path, is syntactically valid, and exports the symbols the rest of the work will reference |
| **Test** | The test file exists, is collected by the test runner, and **fails on an assertion** |

The second row carries a distinction that matters: a test that fails because of an import error or a syntax error is not a valid test, it is a broken one. It has not demonstrated that the behaviour is missing — only that the test cannot run. Phase One tests must fail for the *right* reason, and the success criteria should say so.

**Assumption:** Phase One work is executed by Workers through the normal lifecycle, not performed directly by the Developer. This keeps stub and test creation auditable and inspectable like any other work. If the Developer is meant to create stubs itself outside the task flow, say so — it would be an exception to "all work is a task".

**Assumption:** A Phase One test is expected to fail at the end of Phase One. A passing test in Phase One means either the behaviour already exists or the test is not testing anything, and both are worth surfacing at the gate rather than later.

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

```
Submission
  Phase One
    group "stubs"  = [create auth.ts, create session.ts]
    group "tests"  = [test auth, test session]   ordered after stubs
  Phase Two
    group "auth"   = [implement auth]
    group "session"= [implement session]
    group "audit"  = [implement audit]  shares auth.ts with "auth" → priority

maxParallelGroups: 2

t=0   Phase One: "stubs" starts. "tests" waits — groupOrder.
t=1   "stubs" completes. "tests" starts.
t=2   "tests" completes (tests now failing). Phase One done.
t=3   Phase Two: "auth" and "session" start. "audit" waits on priority.
t=4   "auth" completes → "audit" starts.
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
| `draft` | Defined by the Developer but not yet finalized with the Human | Developer |
| `pending` | Finalized and awaiting assignment | Developer |
| `assigned` | Handed to a Worker, not yet started | Manager |
| `in_progress` | Actively being executed | Worker |
| `completed` | Executed and met all success criteria | Worker, confirmed by Manager |
| `failed` | Execution ended without meeting success criteria | Worker |
| `rejected` | Manager inspection found problems despite reported success | Manager |
| `blocked` | Cannot proceed and requires Developer input | Worker or Manager |

**Assumption:** `rejected` and `blocked` are modelled as distinct states because they have different owners — a rejection is closed by the Developer creating a remediation task, whereas a block is answered by the Developer revising or splitting the original task. Simplify if this distinction is not worth carrying.

## Task Lifecycle

```
  ┌────────┐  finalize   ┌─────────┐  assign   ┌──────────┐  start   ┌────────────┐
  │ draft  │────────────▶│ pending │───────────▶│ assigned │─────────▶│ in_progress│
  └────────┘             └─────────┘            └──────────┘          └─────┬──────┘
                                                                            │
                            ┌───────────────────────────────────────────────┤
                            ▼                                               ▼
                      ┌───────────┐                                 ┌────────────┐
                      │ completed │                                 │  failed    │
                      └───────────┘                                 └────────────┘
                            │                                               │
                   inspect  │                                               │ escalate
                            ▼                                               │
                      accepted? ── no ──▶ ┌───────────┐                     │
                          │                │ rejected │                     │
                          ▼                └───────────┘                     │
                     closed                                                      │
                                                                              │
                            ┌──────────────────────────────────────────────────┘
                            ▼  Developer creates remediation task
                       (back to draft)
```

The loop through `rejected` and `failed` is the system's main corrective path. Note that in every failure case, the **Manager does not retry** — it escalates, and only the Developer can produce follow-up work. See [ADR-0001](../adr/0001-developer-only-task-creation.md).

A failure also holds back anything sequenced behind it: in-group [dependencies](#task-dependencies), later groups in the same phase, and all later phases. See [Parallel Order](#parallel-order).

## Task Dependencies

A task may declare `dependsOn` — the set of tasks that must **complete successfully** before it becomes assignable.

- Dependencies are **intra-group only**. A dependency never crosses a group boundary — use `groupOrder` within a phase, or a later phase, for anything wider.
- Dependencies are set by the **Developer** at creation, from knowledge of the codebase.
- The **Manager** respects dependencies when assigning, and may not assign a task whose dependencies are unmet.
- Dependencies are **ordering only**. A dependency does not grant access to another task's files — each task's permissions remain scoped to its own target files.

Only `completed` satisfies a dependency. A failed, rejected, or blocked dependency leaves its dependents unassignable, because work built on an unfinished or failed foundation is not sound — running an implementation task against a stub that failed would produce a meaningless result.

The consequence is that one failure **stalls what depends on it, not the whole queue**. Independent groups and phases continue normally. The stall resolves when the Developer acts on the escalation and the dependency eventually completes.

## Task Scheduling Rules

1. **The Manager executes the plan; it does not build one.** Phases, grouping, dependencies, and priority are all declared by the Developer. The Manager's scheduling is a traversal of that plan, not an optimisation.
2. **Phase One comes first, always.** No phase after the first may begin until Phase One is fully `completed`. See [Phase One](#phase-one).
3. **The Manager assigns; Workers never self-schedule.** A Worker with no assignment is idle and waits.
4. **One task per Worker.** A Worker holds at most one non-terminal task at a time. See [ADR-0002](../adr/0002-single-task-workers.md).
5. **Dependencies first.** A task is assignable only when every task it depends on is `completed`.
6. **Priority over file overlap.** Where two tasks in different groups or phases share a file, the higher-priority one goes first, and the other waits. See [File Ownership](../permissions/README.md#file-ownership).
7. **Permissions follow assignment.** A Worker's access is provisioned for the assigned task and withdrawn when it reaches a terminal state.
8. **The parallelism limit is a ceiling, not a target.** The Manager runs as many groups as the limit allows, but never exceeds it.

## Task Completion Rules

A task is `completed` only when all of the following hold:

1. Every declared target file has been addressed.
2. Every success criterion is satisfied — tests pass, assertions hold. For a Phase One test task, the criterion is that the test fails on an assertion rather than passing or erroring.
3. Execution stayed within the task's file scope; no undeclared file was modified.
4. The Worker reported completion with evidence for each criterion.
5. The Manager's inspection agrees.

If inspection disagrees, the task becomes `rejected` regardless of the Worker's report. The Worker reporting success is a claim, not a verdict — the Manager holds the verdict.

## See Also

- [Task Specification](../specifications/task-spec.md)
- [System Roles](../system-roles/README.md)
- [Execution](../execution/README.md)
- [Permissions](../permissions/README.md)
- [Testing](../testing/README.md)
- [ADR-0005 — Predefined Parallel Order](../adr/0005-predefined-parallel-order.md)
- [ADR-0006 — Phase One Is Mandatory](../adr/0006-phase-one-is-mandatory.md)
