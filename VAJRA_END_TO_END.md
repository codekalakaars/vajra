# Vajra: End-to-End Design

**Status:** Design locked for the first end-to-end build.
**Date:** 2026-09-30

## Purpose

Vajra is an interactive, multi-language coding harness. A Developer agent plans work with the Human, a Manager runs the plan by spawning and killing Workers, and Workers do the work in parallel where the plan allows it. This document fixes the end-to-end flow and the decisions the first build depends on.

The first build does not have to be fast. Any real speedup over one agent working alone is acceptable; the architecture is what has to be right. Speed comes later, from better scheduling, better plans and cheaper Workers.

## Table of Contents

- [Flow](#flow)
- [Roles](#roles)
- [The Task](#the-task)
- [Scheduling](#scheduling)
- [Worker Lifecycle](#worker-lifecycle)
- [Context Compaction](#context-compaction)
- [The Checkpoint](#the-checkpoint)
- [Verification](#verification)
- [State](#state)
- [Progress Display](#progress-display)
- [Out of Scope](#out-of-scope)
- [ADR Impact](#adr-impact)
- [Open Questions](#open-questions)

## Flow

```
Human ⇄ Developer            multi-turn conversation, plan proposed
          │
          │  Human confirms: "send to Manager?" → yes
          ▼
       Manager                validates plan, schedules, spawns Workers
          │
   ┌──────┼──────┐
   ▼      ▼      ▼
  W1     W2     W3            run in parallel where the plan allows
   │      │      │            compact their own context as they go
   ▼      ▼      ▼
       Manager                verifies each task; accepts, or kills and respawns
          │
          ▼
      Developer               reports results to the Human
```

1. The Human and the Developer talk over several turns. The Developer reads the code it needs, asks questions, and builds up context.
2. The Developer proposes a plan: a set of tasks with dependencies and file sets.
3. **The Developer asks the Human to confirm before anything is sent to the Manager.** Nothing runs without that confirmation.
4. The Manager validates the plan and starts every task whose dependencies are met, one Worker per task, up to the concurrency limit.
5. Each Worker executes its task, compacting its own context when it fills up.
6. When a Worker reports done, the Manager runs verification. A pass completes the task and kills the Worker. A failure kills the Worker and spawns a new one with a better message.
7. Each completed task may unblock others; the Manager spawns Workers for them.
8. When all tasks are complete, or one is escalated, the Developer reports back to the Human.

## Roles

| Role | Is an agent | Does | Never does |
|------|:-----------:|------|-----------|
| Human | No | Talks to the Developer, confirms plans, accepts results | Talks to the Manager or Workers |
| Developer | Yes | Converses, reads code, writes the plan, writes each task's brief | Sends a plan without Human confirmation; writes code |
| Manager | Yes (plus deterministic code) | Validates plans, schedules, spawns and kills Workers, verifies, writes failure findings | Creates tasks; writes or edits code |
| Worker | Yes | Executes one task, compacts its own context, reports done or stuck | Touches files outside its task; talks to other Workers |

**All spawning and killing decisions belong to the Manager.**

## The Task

```typescript
interface Task {
  id: string;
  title: string;                 // "Add email_verified column to users"
  brief: string;                 // Everything the Developer knows that this task needs
  excerpts: FileExcerpt[];       // File contents the Developer already read
  writeFiles: string[];          // Files this task may create or modify
  readFiles: string[];           // Files this task may read
  dependsOn: string[];           // Task ids that must complete first
  verify: VerifyCommands;        // Overrides; defaults come from the language adapter
  timeoutSec: number;
}

interface FileExcerpt {
  path: string;
  range?: [number, number];      // Line range; whole file if absent
  content: string;               // Filled in by the harness, not the model
  hash: string;                  // Hash of the file when the content was taken
}
```

**The Developer names excerpts; the harness fills them.** The Developer gives a path and an optional line range. When the Human confirms the plan, the harness reads the file and stores the content and the file's hash. The model never copies file contents into a plan, so an excerpt cannot be misquoted.

**A stale excerpt is dropped, not trusted.** When a Worker is spawned, the harness checks each excerpt's hash against the file on disk. If an earlier task changed the file, the excerpt is removed and the Worker is told to read that file itself.

**The brief carries the Developer's context.** A Worker should not have to rediscover what the Developer already learned. The brief states the goal, the decisions already made with the Human, the conventions that apply, and how the task fits the whole plan. Files the Developer already read go in `excerpts`, so the Worker does not read them again.

**A Worker gets only relevant files.** `readFiles` and `writeFiles` define what it can see and change. It does not get the whole codebase.

## Scheduling

Parallelism is **hybrid**: the Developer declares it, the Manager validates it.

- The Developer declares `dependsOn` and each task's `writeFiles`.
- The Manager refuses a plan that contains a dependency cycle or depends on a task that does not exist.
- **Two tasks that write the same file never run at the same time**, even if the plan does not order them. The Manager runs them one after the other, in plan order.
- **Reading is shared.** A task takes a shared lease on its `readFiles` and an exclusive lease on its `writeFiles`. Any number of tasks may read a file together; a task writing it waits for them, and they wait for it. (Today every file is locked exclusively, so two tasks that only read the same file cannot run together.)
- A task is **ready** when every task it depends on is complete and none of its `writeFiles` is held by a running task.
- The Manager spawns a Worker for each ready task, up to a concurrency limit (a config value; default 4).
- Every time a task completes or fails, the Manager rechecks which tasks are ready.

## Worker Lifecycle

```
spawn ─▶ executing ─▶ compacting ─▶ executing ─▶ … ─▶ reports done ─▶ verifying
             │                                                          │
             ├─▶ reports stuck ──────────────┐                 pass ────┤──▶ completed, Worker killed
             ├─▶ error or timeout ───────────┤                 fail ────┘
             ▼                               ▼                          │
                              Worker killed; Manager writes findings ◀─┘
                                             │
                          respawns left? ─── yes ──▶ spawn new Worker with checkpoint + findings
                                             │
                                             no ──▶ task escalated to the Developer
```

The Manager kills a Worker when:

| Trigger | Outcome |
|---------|---------|
| Task verified | Task completed |
| Verification failed | Respawn |
| Worker reports it cannot compact further | Respawn |
| Unrecoverable error | Respawn |
| Timeout | Respawn |

**Respawns are bounded.** Each task allows 2 respawns (3 Workers in total). Every non-accepting outcome uses one, including a review rejection of work the ladder passed. When they run out, the task's changes are rolled back and it is escalated to the Developer, who can split or rewrite it and must return to the Human before sending a changed plan.

**A respawn comes with a better message.** The new Worker receives the original task, the last [checkpoint](#the-checkpoint) of the Worker it replaces, and the Manager's findings: what failed, with the evidence. Findings say what is wrong, not how to fix it.

**A respawn keeps the attempt's changes.** The killed Worker's files stay on disk, and the checkpoint lists them. Rolling back only happens when the task fails for good. See [ADR-0016](docs/adr/0016-failed-attempts-are-respawned.md).

**Killing a Worker** means aborting its loop, withdrawing its sandbox handle, and releasing its locks. Every Worker has its own abort signal, linked to the session's, and its task's `timeoutSec` applies to the whole attempt, not only to verification commands.

A Worker never outlives its task.

## Context Compaction

A Worker manages its own context during the task. It does not die just because its context filled up. The decision is [ADR-0015](docs/adr/0015-workers-compact-their-own-context.md).

**Generated code does not live in context.** Everything a Worker writes goes to disk as it works. Its context only needs to know which files it changed, not their contents; it can read a file again if it needs to.

**The runtime triggers compaction, not the model.** When a Worker's context reaches 70% of its model's window, the runtime pauses it and asks it to write a checkpoint. The runtime then replaces the conversation with:

- the task and brief, unchanged;
- the checkpoint.

Raw file reads, command output and old reasoning are dropped.

**A Worker is stuck, and reports it, when:**

- after compacting, the checkpoint alone takes more than 40% of the window; or
- it has compacted 3 times with no progress in between. Progress means a new file written, or a verification step that did not pass before now passing.

Either one means the task is too big or going in circles, and a fresh Worker with the Manager's findings is more likely to succeed.

## The Checkpoint

Compaction and respawn use the **same format**. A compacting Worker writes a checkpoint for itself; a killed Worker's last checkpoint goes to its replacement.

```typescript
interface Checkpoint {
  taskId: string;
  sequence: number;              // Increments with every compaction
  filesChanged: string[];        // Paths only; contents are on disk
  decisions: { decision: string; reason: string }[];
  done: string[];
  remaining: string[];
  lastVerification?: VerificationResult;
  notes: string;                 // Anything else the next context needs
}
```

## Verification

Verification is a **generic ladder with commands from a language adapter**:

1. **Compiles.** Build or type-check.
2. **Runs.** The entry point starts without crashing, where there is one.
3. **Tests.** The project's relevant tests pass, where there are any.

The ladder stops at the first step that fails. A step that does not apply is skipped with a reason, and at least one step must apply.

**A language adapter only supplies commands.** It detects the language from the project manifest and supplies the default build, run and test commands. It does not parse code; understanding code is the model's job.

| Manifest | Language | Default commands |
|----------|----------|------------------|
| `package.json` | JavaScript / TypeScript | `tsc --noEmit` if TypeScript; the `test` script |
| `pyproject.toml`, `requirements.txt` | Python | `python -m compileall`; `pytest` |
| `go.mod` | Go | `go build ./...`; `go test ./...` |
| `Cargo.toml` | Rust | `cargo check`; `cargo test` |
| `pom.xml`, `build.gradle` | Java | `mvn -q compile` / `gradle compileJava`; the matching test task |

The Developer can override any command per task through `verify`. A project with several languages gets one adapter per manifest, and each task uses the adapter for its `writeFiles`.

After the ladder passes, the Manager agent reviews the diff against the brief. It can fail work the ladder passed. It can never pass work the ladder failed.

## State

All state lives in the existing SQLite database at `~/.vajra/vajra.db`, next to the sessions and transcripts it already stores. Several Workers write state at the same time; SQLite in WAL mode handles that, and a directory of JSON files would not.

New tables:

| Table | Holds |
|-------|-------|
| `plans` | A confirmed plan, its session, and when the Human confirmed it |
| `tasks` | Task definition, status, respawn count |
| `workers` | Worker id, task, model, status, start and end, kill reason |
| `checkpoints` | Every checkpoint, by task and sequence |
| `events` | Worker events: tool calls, compactions, verification steps, kills |

## Progress Display

Progress is shown as **live status lines driven by events**, not percentages. A Worker cannot know that it is 40% done, so a percentage would be invented.

```
W1  db-schema      editing migrations/004_email.sql   ctx 31%   0:42
W2  email-service  running tests                      ctx 58%   1:10
W3  signup-form    compacting (2nd)                   ctx 71%   0:55
    verify-page    waiting on email-service

3 running · 1 waiting · 2 completed
```

A line updates on every Worker event: a tool call, a compaction, a verification step, or a kill.

## Out of Scope

Not part of the first build:

- Remote control (an API or server mode).
- Kill triggers beyond those listed in [Worker Lifecycle](#worker-lifecycle), such as latency or memory pressure.
- Peer awareness and access requests ([ADR-0014](docs/adr/0014-peer-aware-workers-and-access-requests.md)).
- Measured speedup targets. Measure first, then set targets.

## ADR Impact

| ADR | Effect |
|-----|--------|
| [ADR-0001](docs/adr/0001-developer-only-task-creation.md) | Unchanged. Only the Developer creates tasks; a respawn re-runs an existing task |
| [ADR-0002](docs/adr/0002-single-task-workers.md) | Unchanged. One task per Worker |
| [ADR-0005](docs/adr/0005-predefined-parallel-order.md) | Consistent. The Developer declares the order; the Manager only validates it and serialises write conflicts |
| [ADR-0013](docs/adr/0013-manager-verifies-reviews-and-retires-workers.md) | Amended by ADR-0016 |
| [ADR-0015](docs/adr/0015-workers-compact-their-own-context.md) | New. Compaction, the checkpoint, and the stuck rule |
| [ADR-0016](docs/adr/0016-failed-attempts-are-respawned.md) | New. Every failed attempt is respawned with the checkpoint and findings |

## Settled Questions

| Question | Answer |
|----------|--------|
| Is 70% the right compaction trigger for every model? | It is the default, and it is configurable. Measure before changing it |
| Should a respawned Worker use a stronger model? | Not in the first build. Every Worker uses the configured Worker model |
| Does a review rejection count against the respawn limit? | Yes. Every non-accepting outcome uses one respawn |
| How are excerpts kept current after an earlier task changes the file? | Each excerpt carries the file's hash; a stale excerpt is dropped at spawn, and the Worker reads the file itself |
| Is the Manager agent's review required? | Only when a Manager model is configured. Without one, the ladder alone decides |

## Open Questions

- Should the compaction trigger depend on the window size?
- Should the Manager be able to roll back before respawning, when the approach itself is wrong?
