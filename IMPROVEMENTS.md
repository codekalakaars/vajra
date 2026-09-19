# Vajra — Remaining Improvements

All completed items removed. Remaining tasks grouped by disjoint file sets so
multiple groups can be worked on in parallel with zero merge conflicts.

Each group lists the files it touches. No two groups share a file.

---

## Group 1: Worker Pool

**Files:** `packages/server/src/agent/pool.ts`

### 4.9 Pool slot accounting drifts, and a drained pool is permanently dead

`notifyWaiter` hands an idle worker to a waiter without decrementing
`availableSlots`. `drain()` sets `availableSlots = 0` with no reset path.

**Fix.** Make slot accounting a single explicit semaphore with acquire/release
symmetry, and have `drain` return the pool to a constructed state.

---

## Group 2: Master Loop

**Files:** `packages/server/src/agent/master.ts`

### 3.3 Validation commands inherit the task's narrow sandbox

Child processes inherit Landlock restrictions. A worker confined to `src/api.ts`
runs `npm test`, which needs write access to caches. Validation fails for reasons
unrelated to the code change.

**Fix.** Run validation in a separately launched worker whose ruleset grants the
project root read-write plus cache directories.

### 3.4 Speculative execution bypasses file locking -- and is dead code

The speculative branch pushes tasks straight into `assignable` without ever
calling `tryAcquire`. It cannot fire (the filter is always empty) but the code
is misleading.

**Fix.** Delete the feature and its rollback bookkeeping.

### 4.4 Worker resource limits are never applied

`WorkerJob` carries `resourceLimits`, `executeTask` reads
`resourceLimits?.maxToolCalls`. Nothing populates it.

**Fix.** Resolve limits once from config and thread them through both call sites.

### 5.5 totalToolCalls is always zero, and there is no cost accounting

`MasterResult.totalToolCalls` is declared, returned, and never incremented. No
token or spend tracking exists anywhere.

**Fix.** Return per-task tool-call and token counts from `executeTask`, aggregate
them, persist to `tasks`, and add a configurable per-plan budget.

### 5.12 Skipped tasks are counted as completed

`queue.skipTask` is followed by `completedTasks.push(task.id)`, so the final
summary includes work that was deliberately not done.

**Fix.** Track skipped separately and report all three counts.

---

---

## Group 3: Developer Agent

**Files:** `packages/server/src/agent/developer.ts`

### 4.6 Independent groups are not independent

The grouping loop marks tasks as assigned while iterating, so a task whose
dependency was just assigned joins the same group. Nearly every task lands in
group 0.

**Fix.** Compute proper topological levels: group n is every task whose
dependencies all sit in groups less than n.

### 5.4 Task duration estimates are invented

`estimateTaskDurations` multiplies a hardcoded 30/120/240-minute base by file
count and validation count ratios. These numbers reach the user as estimates.

**Fix.** Remove the field, or derive from recorded historical task durations
using the `started_at` and `completed_at` columns.

---

## Group 4: Project Manager

**Files:** `packages/server/src/project/manager.ts`

### 5.11 sendMessage during execution starts a competing agent loop

Status `executing` falls through to the legacy `sendWorkerMessage` path, which
launches an independent `agentLoop` while the Master is mid-run.

**Fix.** Reject or queue user messages while `executing`, and route them to the
Master as guidance.

---

## Group 5: Database and Schema

**Files:** `packages/server/src/db/*`

### 6.4 The agent_messages table has no implementation

The schema documents an inter-agent message bus. Nothing writes to it, and
masterLoop deletes from it at startup. This is the right table for per-task
summaries.

**Fix.** Implement the table as the inter-agent message bus, or remove it.

---

---

---

---

---

## Group 6: Orchestration Tests

**Files:** `packages/server/test/*` (new files only)

### 6.6 No tests cover the orchestration path

There is not one test for `master.ts`, `developer.ts`, `taskqueue.ts`,
`context.ts`, or `pool.ts` -- the five files where every blocker in section 2
lives.

**Fix.** Add tests for:
- A task with the same file in readFile and writeFile reaches running
- A default-permission task can execute its validation command
- A pooled worker is not reused across differing permission sets
- Rollback restores a modified file to its original content at the right path
- A validation command printing "0 failures" passes
- compressMessages never returns a tool result without its parent tool call

**New test files:**
- `test/taskqueue-overlap.test.mjs` — 6 tests for TaskQueue dependency, overlap, and status
- `test/pool-permissions.test.mjs` — 4 tests for permission-based worker reuse
- `test/rollback.test.mjs` — 4 tests for ChangeHistory rollback
- `test/validation-output.test.mjs` — 4 tests for validation semantics and compressMessages pairing
- `test/master-loop.test.mjs` — 3 tests for masterLoop orchestration

---

## Group 7: Dead Code and CLI Dedup

**Files:** Various (removals only, no overlaps with Groups 1-12)

### 6.1 Substantial dead code in the hot path

- `TaskQueue.getSmartBatches`, `getParallelBatches`, `canRunInParallel`,
  `hasConflict`, `getLockedFiles`, `getTaskFiles` -- none are called. Already removed
- `compressSummaryByRelevance` and `formatSummaryIndex` are imported and unused. Already removed
- `identifyKeyFiles(summary, tree)` ignores `tree`. Already removed
- `analyzeArchitecture` and `readTaskContext` ignore `projectDir`. Already removed
- `extractRelevantLines` ignores `filePath`. Already removed
- `compressMessage` in `context.ts` is never called. Already removed

**Fix.** Delete it. Already cleaned up

### 6.2 The CLI duplicates the server's agent stack

`packages/cli/src/agent/` carries its own `developer.ts`, `taskqueue.ts`,
`summary.ts`, `registry.ts`, `tools.ts`, and `tree.ts` -- near-copies of the
server versions, already diverged. Every fix must currently be applied twice.

**Fix.** Extract the shared agent core into a package both consume.

**Created:** `packages/agent-core/` with shared pure functions:
- `tree.ts` — buildNestedTree (identical in both)
- `summary.ts` — SummaryEntry, extractSymbols, countImports, countExports, getPreview, shouldSkipFile, formatSummaryIndexHierarchical, searchSummary
- `plan.ts` — TaskState, AgentState, detectAndRemoveCircularDeps, addFileLevelDependencies, computeWaves, optimizeTaskOrder, computeReadyTasks
- `tools.ts` — ParsedToolCall, parseToolCall

---

## Group 8: Architectural

**Files:** New files / major restructures

### 7.1 Execute on an isolated copy, not the user's working tree

Workers write directly to the live project. Rollback is best-effort file-content
restore held in process memory. A partial failure leaves a half-edited tree.

**Fix.** Give each task a git worktree or overlay directory. Validate there,
then merge successful tasks back.

**Status:** ChangeHistory rollback is working (tested). Isolated execution
(worktree/overlay) requires deeper integration — tracked for future work.

### 7.2 Make the Master an actual agent

The Master is a scheduler with an LLM provider it never calls. It cannot
re-plan when a task fails, cannot split a task, cannot reassign work.

**Fix.** Give it a real tool loop with get_task_status, retry_task, amend_task,
split_task, and abort_plan tools.

**Status:** Deferred — requires significant refactoring of the master loop.

### 7.3 Let the Developer verify its own plan before proposing it

The Developer emits a plan with no check that referenced files exist, that paths
sit inside the project, that validation commands are runnable, or that the
dependency graph makes sense.

**Fix.** Add a validation pass before planProposed: resolve every path, reject
traversal outside the project root, confirm validation commands exist on PATH,
and surface cycle removal to the user.

**Status:** Partially addressed — detectAndRemoveCircularDeps and
addFileLevelDependencies are now in shared agent-core package and used by both
CLI and server. Full plan validation (path resolution, command existence)
deferred.

### 7.4 Separate the transport channel per agent

One project-wide event stream forces the UI to guess which agent produced what.
Every event from a worker should carry agentId and taskId, and the client should
be able to subscribe per agent.

**Fix.** Add agentId and taskId to all events, and implement per-agent
subscription on the client.

**Completed:**
- Fixed `workerProgress` payload to use `taskId` (was `task`) in protocol types
- Added optional `agentId` and `taskId` to `ConflictPayload` for per-agent filtering
- All worker events (`workerStarted`, `workerProgress`, `workerCompleted`, `workerFailed`)
  already carry `agentId` and `taskId`
- `assistantDelta` and `thinkingDelta` already support optional `agentId`/`taskId`
