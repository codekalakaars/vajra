# Task Specification

## Purpose

This document defines the formal task schema and state machine. Field definitions only — rationale lives in [Tasks](../tasks/README.md).

## Table of Contents

- [Task Schema](#task-schema)
- [Submission Schema](#submission-schema)
- [Phase Schema](#phase-schema)
- [Verification Ladder Schema](#verification-ladder-schema)
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
  | "frozen"
  | "verifying"
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

  /**
   * Exact paths this task may modify. Defined upfront, may not exist yet;
   * a missing file is created by the Worker that owns the task.
   */
  targetFiles: string[];
  /** Paths the task may read but not modify. */
  readOnlyFiles?: string[];

  successCriteria: SuccessCriterion[];

  /** How the Manager's mechanical part verifies this task. See Verification Ladder Schema. */
  verification: VerificationLadder;
  /** How many changes_requested rounds the Manager may use. Default 2. */
  maxReviewRounds?: number;
  /** True only for a task that writes a test for missing behaviour; its test is expected to fail on an assertion. */
  writesFailingTest?: boolean;
  /** Set by the Manager: changes_requested rounds used so far. Starts at 0. */
  reviewRound?: number;

  /** The phase this task belongs to. */
  phase: number;
  /** The parallel group within the phase. Exactly one. */
  group: string;

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

**Assumption:** `maxReviewRounds` defaults to 2, so a task gets three attempts in total. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

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
  /** Sequential position, starting at 1. No phase is special. */
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
// The schema group runs first; then config and api run together.
{ number: 1, name: "core", groupOrder: [["schema"], ["config", "api"]] }
```

A task's `phase` and `group` must both resolve within `phases` and that phase's `groupOrder` respectively.

There is no mandatory first phase. Phase One, with its stub and failing-test tasks, was removed by [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

## Verification Ladder Schema

Every task declares how it is verified. The Manager's mechanical part climbs the rungs in order after the Worker reports completion and stops at the first that fails. Rationale lives in [Verification Ladder](../tasks/README.md#verification-ladder) and [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

```typescript
/** A rung either applies, with its configuration, or is declared not applicable with a reason. */
type Rung<T> = T | { notApplicable: string };

interface VerificationLadder {
  /** 1. Does the changed code build or type-check? */
  compile: Rung<{ command: string }>;
  /** 2. Does it start without crashing? */
  run: Rung<{ command: string; ready?: ReadyCheck }>;
  /** 3. Does it work against the services it needs? Each is stubbed or checked. */
  dependencies: Rung<{ services: ServiceDependency[] }>;
  /** 4. If it is a server, does it start and answer correctly? */
  serve: Rung<{
    build?: string[];
    serve: string[];
    /** 0 = OS-assigned. */
    port: number;
    ready: ReadyCheck;
    probes: Probe[];
  }>;
  /** 5. Do the project's relevant tests pass? */
  tests: Rung<{ command: string; format: "junit" | "tap" }>;
}

interface ServiceDependency {
  name: string;
  kind: "database" | "http" | "queue" | "cache" | "other";
  mode: "stub" | "check";
  /** For mode "stub": how the stub is provided. */
  stub?: string;
  /** For mode "check": the health check. */
  check?: string;
}

interface LadderResult {
  /** The highest rung that passed; 0 if none did. */
  highestRung: 0 | 1 | 2 | 3 | 4 | 5;
  rungs: Array<{
    rung: "compile" | "run" | "dependencies" | "serve" | "tests";
    verdict: TestVerdict | "not_applicable";
    evidence: string;
  }>;
}

type AccessDecision = "granted" | "denied" | "not_needed" | "freeze" | "continue_meanwhile";

interface AccessGrant {
  taskId: string;
  file: string;
  mode: "write" | "read";
  reason: string;
  decision: AccessDecision;
  decidedAt: string;
}
```

`Probe` and `ReadyCheck` are the probe and readiness shapes described in [Testing APIs Directly](../testing/README.md#testing-apis-directly). `TestVerdict` is defined by the [verdict contract](../adr/0007-test-verdict-contract.md).

- **Every rung expects `pass`.** `flaky`, `timeout` and `failed_environment` never satisfy a rung. The one exception is a task with `writesFailingTest: true`, whose test is expected to fail on an assertion (`fail_on_assertion`).
- **A service in rung 3 is stubbed or checked, never assumed.** A service that is neither stubbed nor healthy fails the rung as `failed_environment`.
- **Rungs map onto tiers.** Rungs 1–3 are tier 2 (structural). Rungs 4–5 are tier 1 (behavioural) when their probes or tests assert behaviour. See [Criterion Tiers](#criterion-tiers).
- **Reports name `highestRung`**, so a task that only compiled is never reported as tested.

**Assumption:** the Manager's mechanical verifier provisions stubs and runs health checks for rung 3. Workers do not write service stubs unless the Developer planned that as a task.


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
| **3 — Review** | `review` | A judgement no command can decide | The Manager agent reads the output |

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

**The rule: every task carries at least one tier 1 or tier 2 criterion. A `review` criterion is additive and never sufficient on its own.** An applicable [ladder](#verification-ladder-schema) rung satisfies this rule, since every rung is at least tier 2.

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
  allowedFiles: string[];   // task.targetFiles ∪ write access grants
  readOnlyFiles: string[];  // from task.readOnlyFiles, default []
  blockedFiles: string[];   // everything else
  allowNetwork: boolean;    // default false
}
```

Permissions are still derived per task and withdrawn at the end of it. A write access grant ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)) adds its file to `allowedFiles` for the rest of the task only; it is recorded as an `AccessGrant` and never gives a Worker a file another active task owns.

**Assumption:** a read grant adds its file to `readOnlyFiles` in the same way. ADR-0014 leaves open whether read-only grants exist.

See [Permission Specification](permission-spec.md).

## State Machine

```
draft ──approve──▶ pending ──assign──▶ assigned ──start──▶ in_progress
  ▲                   │                    │
  └─────withdraw──────┘                    └──cancel──▶ pending

in_progress ──freeze──────────▶ frozen ──resume───────▶ in_progress
                                  └────wait timeout───▶ blocked

in_progress ──task.fail───────▶ failed
in_progress ──task.blocked────▶ blocked
in_progress ──task.complete───▶ verifying

verifying ──accepted──────────▶ completed     Worker killed, files released
verifying ──changes_requested─▶ in_progress   same Worker, reviewRound + 1
verifying ──rejected──────────▶ rejected      Worker killed; also when rounds are exhausted

failed, rejected, blocked ──▶ escalated; answered by the Developer with a new task
```

Legal transitions, and who may perform them:

| From | To | Actor | Condition |
|------|----|-------|-----------|
| `draft` | `pending` | Developer | Human has approved it |
| `draft` | `draft` | Developer | Description refined |
| `pending` | `assigned` | Manager (mechanical) | Phase and group active, dependencies `completed`, no higher-priority task holds a shared file, Worker idle |
| `pending` | `draft` | Developer | Withdrawn for revision |
| `assigned` | `in_progress` | Worker | Execution started |
| `assigned` | `pending` | Manager (mechanical) | Cancelled before start |
| `in_progress` | `verifying` | Worker (`task.complete`) | Worker claims all criteria met |
| `in_progress` | `failed` | Worker | Criteria not met |
| `in_progress` | `blocked` | Worker or Manager | Cannot proceed, or an access request implies new work |
| `in_progress` | `frozen` | Manager (agent decides, mechanical enforces) | Access request answered with `freeze`, and the freeze creates no wait cycle |
| `frozen` | `in_progress` | Manager (mechanical) | The awaited file is released and granted (`task.resume`) |
| `frozen` | `blocked` | Manager (mechanical) | Waited past the task timeout |
| `verifying` | `completed` | Manager (agent) | Verdict `accepted`; every applicable rung passed |
| `verifying` | `in_progress` | Manager (agent) | Verdict `changes_requested`; `reviewRound < maxReviewRounds`. `reviewRound` goes up by one |
| `verifying` | `rejected` | Manager (agent) | Verdict `rejected`, or rounds exhausted and the verdict is not `accepted` |
| `completed` | — | — | Terminal; the Worker is killed and its files released |
| `rejected` | — | — | Terminal; the Worker is killed; answered by a new task |
| `failed` | — | — | Terminal; answered by a new task |
| `blocked` | — | — | Terminal; answered by a new task |

No role may perform a transition not listed for it. In particular, a Worker cannot move a task to `completed`: `task.complete` is a claim that moves the task to `verifying`, and only the Manager's verdict closes it. The Manager agent may never move a task to `completed` when any applicable rung did not pass — the mechanical floor. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

## Validation Rules

A task is valid when:

1. `title` and `description` are non-empty.
2. `targetFiles` contains at least one path, and all paths are absolute or repo-relative and normalized.
3. `successCriteria` contains at least one entry, and each is well-formed per its type. **At least one tier 1 or tier 2 check exists**: an applicable ladder rung satisfies this. A task whose criteria are all `review` and whose ladder has no applicable rung is invalid, because nothing about it can be established mechanically. See [Criterion Tiers](#criterion-tiers).
4. A `test` criterion declared `tier: 2` carries a non-empty `establishes` string. A structural proof that does not say what it structurally proves cannot be reviewed, and a plan that hides its own weakness is worse than one that admits it.
5. `verification` is present, and **at least one rung applies**.
6. Every rung declared `notApplicable` carries a non-empty reason.
7. `maxReviewRounds`, if set, is an integer ≥ 0.
8. `phase` and `group` are set, and both resolve within the submission.
9. `dependsOn` contains no self-reference, and **every referenced task is in the same group**. A cross-group reference is invalid — use `groupOrder` or a later phase instead.
10. `dependsOn` is acyclic within the group.
11. `priority` contains no self-reference, and every referenced task exists in the submission.
12. `state`, `origin`, `createdAt`, and `updatedAt` are set.
13. `assignedTo` is present if and only if `state` is `assigned`, `in_progress`, `frozen`, or `verifying`.
14. `rejectionReason` is present if and only if `state` is `rejected`.
15. `blockedReason` is present if and only if `state` is `blocked`.

A phase is valid when:

16. `phases` is non-empty, and `number` values are unique and start at 1.
17. Every phase's `groupOrder` lists each of its groups exactly once, with no empty inner array.

A submission is valid when, in addition:

18. `maxParallelGroups` is an integer ≥ 1.
19. Every task's `group` appears in its phase's `groupOrder`.
20. No two tasks in the same group share a file **unless** one is reachable from the other via `dependsOn`.

Rule 20 is the most useful of these for catching planning errors. An intra-group collision with no dependency between the tasks is almost always a grouping mistake, and catching it at submission turns a runtime stall into a submission error. It covers declared `targetFiles` only; files added by access grants at runtime are serialised by file ownership instead.

A task or submission failing validation cannot be sent via `task.submit`.

## See Also

- [Permission Specification](permission-spec.md)
- [Agent Specification](agent-spec.md)
- [Tasks](../tasks/README.md)
- [Protocol](../communication/protocol.md)
- [ADR-0012 — A Verification Ladder Replaces Phase One](../adr/0012-verification-ladder-replaces-phase-one.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](../adr/0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](../adr/0014-peer-aware-workers-and-access-requests.md)
