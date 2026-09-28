# Task Specification

## Purpose

This document defines the formal task schema and state machine. Field definitions only — rationale lives in [Tasks](../tasks/README.md).

## Table of Contents

- [Task Schema](#task-schema)
- [Submission Schema](#submission-schema)
- [Phase Schema](#phase-schema)
- [Success Criteria](#success-criteria)
- [Criterion Tiers](#criterion-tiers)
- [Task Permissions Reference](#task-permissions-reference)
- [State Machine](#state-machine)
- [Validation Rules](#validation-rules)

## Task Schema

```typescript
type TaskState =
  | "draft"
  | "pending"
  | "assigned"
  | "in_progress"
  | "completed"
  | "failed"
  | "rejected"
  | "blocked";

type TaskOrigin = "human" | "escalation";

interface Task {
  id: string;
  title: string;
  description: string;

  state: TaskState;
  origin: TaskOrigin;

  /** Exact paths this task may modify. Defined upfront, may not exist yet. */
  targetFiles: string[];
  /** Paths the task may read but not modify. */
  readOnlyFiles?: string[];

  successCriteria: SuccessCriterion[];

  /** The phase this task belongs to. Phase 1 is Phase One. */
  phase: number;
  /** The parallel group within the phase. Exactly one. */
  group: string;
  /** Phase One tasks only: which kind of groundwork this is. */
  kind?: "stub" | "test";

  /** Tasks in the SAME group that must be "completed" first. */
  dependsOn?: string[];

  /** Ordering against tasks in OTHER groups or phases that share a file. */
  priority: Record<string, number>;

  /** Set by the Manager on assignment. */
  assignedTo?: string;

  /** Present when state is "rejected"; set by the Manager. */
  rejectionReason?: string;

  /** Present when state is "blocked". */
  blockedReason?: string;

  createdAt: string;
  updatedAt: string;
}
```

`priority` maps a task id to a numeric ordering weight, and is only meaningful between tasks that share a file. It is a **pairwise** relation, not a total order — the Developer sets it only where a collision actually exists, and tasks with no entry in each other's `priority` have no ordering constraint between them.

## Submission Schema

A submission is the unit the Developer hands to the Manager. It carries the plan, not just the tasks.

```typescript
interface TaskSubmission {
  phases: Phase[];
  tasks: Task[];

  /** Maximum groups in flight at once. */
  maxParallelGroups: number;
}
```

`maxParallelGroups` is a ceiling, not a target. The Manager runs as many groups as it allows and never more.

## Phase Schema

```typescript
interface Phase {
  /** Sequential position. Phase 1 is always Phase One. */
  number: number;
  name: string;

  /**
   * Ordering between groups within this phase.
   * Groups listed in the same inner array run together.
   * Later arrays start after earlier ones finish.
   */
  groupOrder: string[][];
}
```

`groupOrder` must list every group in the phase exactly once. An empty inner array is not permitted — a group that needs no ordering relative to others goes in any batch, and ordering it alone achieves that.

```typescript
// Phase One: every stub before any test.
{ number: 1, name: "Phase One", groupOrder: [["stubs"], ["tests"]] }
```

A task's `phase` and `group` must both resolve within `phases` and that phase's `groupOrder` respectively.

```

## Success Criteria

```typescript
type SuccessCriterionType = "test" | "assertion" | "review";

interface SuccessCriterion {
  id: string;
  type: SuccessCriterionType;
  description: string;

  /** For type "test": the command that must exit zero. */
  command?: string;
  /** For type "assertion": the condition to check. */
  assertion?: string;
}
```

At least one criterion is required. A `test` criterion requires a `command`; an `assertion` criterion requires an `assertion`; a `review` criterion requires only a `description`.

## Criterion Tiers

Criteria are not equally strong, and a plan that does not say which it is using cannot be judged honestly. Every criterion sits on one of three tiers. See [ADR-0011](../adr/0011-tiered-success-criteria.md).

| Tier | Types | What it establishes | Judged by |
|------|-------|---------------------|-----------|
| **1 — Behavioural** | `test` | The behaviour is right, not merely present | A command that fails before the change and passes after |
| **2 — Structural** | `test` | The change is real, wired in, and well-formed | A command that fails before and passes after, over a property weaker than behaviour |
| **3 — Review** | `review` | A judgement no command can decide | The Manager reads the output |

A `test` criterion carries its tier explicitly, because the same mechanism — a command that fails then passes — can establish either a behavioural or a structural fact, and the difference is entirely in what the command asserts:

```typescript
interface TestCriterion extends SuccessCriterion {
  type: "test";
  /** The command that must exit zero after the change. */
  command: string;
  /** Whether this proves behaviour or only structure. Default: "behavioural". */
  tier?: 1 | 2;
  /**
   * For tier 2: what the command establishes. Stated so the weakness is
   * visible in the plan rather than discovered at inspection.
   */
  establishes?: string;
}
```

**The rule: every task carries at least one tier 1 or tier 2 criterion. A `review` criterion is additive and never sufficient on its own.**

Tier 2 is the middle position that lets the harness take work with no test yet — a new endpoint, a new screen, a new module. It is a real before/after transition: the import does not resolve before, the route is not registered before, the module does not compile before. It simply does not claim more than it can, and it must say what it does claim.

```typescript
// Tier 1 — the behaviour is correct.
{ id: "c1", type: "test", tier: 1,
  description: "POST /login returns 200 with a token for valid credentials",
  command: "npm test -- login" }

// Tier 2 — the endpoint exists, is routed, and compiles.
{ id: "c2", type: "test", tier: 2,
  description: "src/api/login.ts compiles and the route is registered",
  command: "tsc --noEmit",
  establishes: "type-correctness and route registration, not behaviour" }

// Tier 3 — a judgement no command can make.
{ id: "c3", type: "review",
  description: "the 401 response body matches the shape used elsewhere in the API" }
```

**A tier 2 pass is not a tier 1 pass.** The distinction is a reporting obligation rather than a validation one: the tier appears in the plan, in the verdict, and in the final report to the Human. Reporting both as "passed" would reintroduce the false pass that [ADR-0007](../adr/0007-test-verdict-contract.md) exists to prevent.

**Assumption:** `establishes` is required on a tier 2 criterion. Without it the weaker proof is invisible in the plan, and a reader cannot tell what was actually established. The open question in [ADR-0011](../adr/0011-tiered-success-criteria.md) is where the floor sits for tier 2 — a `tsc` that passes on a file exporting nothing useful is a clean pass over an empty deliverable, so tier 2 needs a stated lower bound.

## Task Permissions Reference

Permissions are derived from a task, never authored independently.

```typescript
interface TaskPermissions {
  taskId: string;
  allowedFiles: string[];   // from task.targetFiles
  readOnlyFiles: string[];  // from task.readOnlyFiles, default []
  blockedFiles: string[];   // everything else
  allowNetwork: boolean;    // default false
}
```

See [Permission Specification](permission-spec.md).

## State Machine

```
draft ──finalize──▶ pending ──assign──▶ assigned ──start──▶ in_progress
  │                    │                    │                   │
  │                    │                    │                   │
  │                    └──withdraw──────────┘                   │
  │                                                                │
  │                                       ┌────────────────────────┤
  │                                       ▼                        ▼
  │                                 completed ◀──inspect ok──┐   failed
  │                                     │                 │      │
  │                                     │            inspect fails
  │                                     ▼                     ▼
  │                                  closed              rejected
  │                                                            │
  └── no transitions out of draft except finalize/withdraw ───┘
                                                                │
                                                    escalated to Developer
                                                                │
  blocked ◀──needs input────────────────────────────────────────┘
    │
  └── only the Developer resolves, by creating a new task
```

Legal transitions, and who may perform them:

| From | To | Actor | Condition |
|------|----|-------|-----------|
| `draft` | `pending` | Developer | Human has finalized it |
| `draft` | `draft` | Developer | Description refined |
| `pending` | `assigned` | Manager | Phase and group active, dependencies `completed`, no higher-priority task holds a shared file, Worker idle |
| `pending` | `draft` | Developer | Withdrawn for revision |
| `assigned` | `in_progress` | Worker | Execution started |
| `assigned` | `pending` | Manager | Cancelled before start |
| `in_progress` | `completed` | Worker | All criteria met — pending inspection |
| `in_progress` | `failed` | Worker | Criteria not met |
| `in_progress` | `blocked` | Worker or Manager | Cannot proceed |
| `completed` | `rejected` | Manager | Inspection disagrees |
| `rejected` | — | — | Terminal; answered by a new task |
| `failed` | — | — | Terminal; answered by a new task |
| `blocked` | — | — | Terminal; answered by a new task |

No role may perform a transition not listed for it. In particular, a Worker cannot move a task to `completed` *and* have it be — the Worker sets `completed` as a claim, and the Manager's inspection is what closes it.

## Validation Rules

A task is valid when:

1. `title` and `description` are non-empty.
2. `targetFiles` contains at least one path, and all paths are absolute or repo-relative and normalized.
3. `successCriteria` contains at least one entry, and each is well-formed per its type. **At least one entry is tier 1 or tier 2**: a task whose criteria are all `review` is invalid, because nothing about it can be established mechanically. See [Criterion Tiers](#criterion-tiers).
3a. A `test` criterion declared `tier: 2` carries a non-empty `establishes` string. A structural proof that does not say what it structurally proves cannot be reviewed, and a plan that hides its own weakness is worse than one that admits it.
4. `phase` and `group` are set, and both resolve within the submission.
5. `dependsOn` contains no self-reference, and **every referenced task is in the same group**. A cross-group reference is invalid — use `groupOrder` or a later phase instead.
6. `dependsOn` is acyclic within the group.
7. `priority` contains no self-reference, and every referenced task exists in the submission.
8. `state`, `origin`, `createdAt`, and `updatedAt` are set.
9. `assignedTo` is present if and only if `state` is `assigned` or `in_progress`.
10. `rejectionReason` is present if and only if `state` is `rejected`.
11. `blockedReason` is present if and only if `state` is `blocked`.

A phase is valid when:

12. `phases` is non-empty, and `number` values are unique and start at 1.
13. **Phase 1 exists** and is named `Phase One`.
14. Every phase's `groupOrder` lists each of its groups exactly once, with no empty inner array.

A submission is valid when, in addition:

15. `maxParallelGroups` is an integer ≥ 1.
16. Every task's `group` appears in its phase's `groupOrder`.
17. **Phase One is well-formed**:
    - it contains at least one `kind: "stub"` task and at least one `kind: "test"` task;
    - every task in phase 1 has `kind` set, and no task outside phase 1 does;
    - no `dependsOn` edge within phase 1 runs from a `test` task to a `stub` task.
18. No two tasks in the same group share a file **unless** one is reachable from the other via `dependsOn`.
19. Each `test` task depends, directly or transitively, on a `stub` task covering the file it tests. This is what guarantees a test cannot be written against a file that does not exist.

Rule 18 is the most useful of these for catching planning errors. An intra-group collision with no dependency between the tasks is almost always a grouping mistake, and catching it at submission turns a runtime stall into a submission error.

Rule 17 does not fully enforce stub-before-test ordering, because `groupOrder` is expressed per phase and the two kinds usually sit in different groups of the same phase. The Developer expresses the ordering in `groupOrder`; validation checks it is well-formed, and `dependsOn` is the fallback for expressing it within one group. See [Phase One](../tasks/README.md#phase-one).

A task or submission failing validation cannot be sent via `task.submit`.

## See Also

- [Permission Specification](permission-spec.md)
- [Agent Specification](agent-spec.md)
- [Tasks](../tasks/README.md)
- [Protocol](../communication/protocol.md)
