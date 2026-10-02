# Architecture

Vajra turns a **plan** (a list of tasks with dependencies) into finished work by running each task on a sandboxed **Worker**, in parallel, under a **Manager**.

```
Developer ──plan──▶ Manager ──task──▶ Worker ──tool calls──▶ confined process
 (creates tasks)    (schedules,        (one model loop        (Landlock; only the
                     retries,           per task attempt)       task's files)
                     hands off)
```

## The three roles

| Role | What it does | Code |
|------|--------------|------|
| **Developer** | Talks to a model and produces the plan: tasks, their files, dependencies, and the commands that verify each one. `vajra run` drives it (`developer/conversation.ts`): it can ask you a question, and a plan it proposes waits for your review. | `packages/vajra/src/developer/` |
| **Manager** | Takes a plan and runs it. Decides which task starts next, how many run at once, which to pause when the CPU is busy, and what to do when one fails. Never edits code itself. | `packages/vajra/src/manager/` |
| **Worker** | One model loop per task attempt. Starts from a compiled context pack, edits files through tools, runs the task's verify commands, and reports a summary. | `packages/vajra/src/worker/` |

A plan comes from one of two places. `vajra run "<task>"` (`cli/run.ts`) has the Developer plan it with you, then hands the accepted plan to the Manager. `vajra bench <suite>` loads `bench/suites/<suite>/plan.json` and hands it to the Manager, with no Developer (`packages/vajra/src/bench/`).

## The packages

| Package | Role |
|---------|------|
| `packages/protocol` | Shared types: the plan, its tasks, file permissions, tool definitions, plan validation. No runtime dependencies. |
| `packages/native` | Rust (napi) addon: run a command with a deadline and kill its process group, scan a project, apply the Landlock sandbox. Linux only. |
| `packages/sandbox` | Everything between the Manager and the OS: policy and file rules, file locks, change history (for rollback), the worker pool, and the confined worker process that serves tool calls. Also the repository index. |
| `packages/vajra` | The orchestrator: Developer, Manager, Worker, the model client, the bench runner and the `vajra` command. |

Dependencies point one way: `vajra → sandbox → native`, and everything may use `protocol`.

## One task, end to end

1. The Manager (`manager/execute-plan.ts`) puts every task in a queue (`taskqueue.ts`) and loops (`master.ts`): pick the ready tasks, start as many as CPU and RAM allow (`governor.ts`), pause the lowest-priority Worker if the CPU saturates.
2. Before a task starts it takes file leases (`leases.ts`): exclusive for files it writes, shared for files it only reads. Two tasks that touch the same file never run together.
3. The Worker (`worker/execute.ts`) builds a context pack (`pack.ts`): the task, what "done" means, the code it will change, contracts, upstream handoffs, the project card. Then it loops: model call, tool calls, until it is done or out of budget.
4. Every tool call goes through the confined worker process (`sandbox/src/process/`), which can only touch the task's files.
5. When the Worker ends, the task's verify commands decide success. A failure rolls the files back (`sandbox/src/change-history.ts`) and the Manager decides whether to retry. A retry is told what the last attempt did and why it failed (`worker/` attempt records, `manager/handoff.ts`).
6. A finished task leaves a handoff (files written, interfaces, a summary) that its dependents' packs include.

## Context management

A Worker's context is bounded in three steps, cheapest first (`worker/`, `model/budget.ts`):

1. every tool result is capped (`output-cap.ts`);
2. stale results are rewritten in place once the window passes `elideAt` (`elide.ts`);
3. past `compactAt` the Worker writes a checkpoint and the conversation restarts from it (`checkpoint.ts`).

Steps 2 and 3 are off by default; the bench showed suite tasks use about 5% of the window. See [ADR-0017](adr/0017-the-manager-compiles-a-context-pack-per-task.md), [0018](adr/0018-compaction-is-a-ladder.md), [0019](adr/0019-a-retry-is-told-what-failed-and-a-finished-task-hands-off.md).

## Configuration

Every run parameter lives in `bench/config.json` and is validated by `packages/vajra/src/bench/config.ts`. No environment variable, flag or in-code default stands in for a missing key. See [bench-and-tuning.md](bench-and-tuning.md).

## What was removed, and why

The repository used to include an interactive terminal UI, saved sessions and resume, an interactive `vajra run` conversation with saved history, a standalone sandbox CLI, a test-running framework (`packages/tester`) and a `video` command. None of it was on the Manager/Worker path, so it was removed. `vajra run` is a plain terminal command that replaces the conversation part. The ADRs marked *Not implemented* describe designs (a verification ladder, Manager review, mutation testing, peer-aware Workers) that were never built.
