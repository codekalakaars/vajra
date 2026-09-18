# Vajra Multi-Agent Pipeline — Analysis and Improvements

Scope: the end-to-end Developer → Master → Worker orchestration path, plus the
sandbox, worker pool, task queue, context handling, persistence, and protocol
surfaces it depends on.

Reviewed at commit `9d3e941` on branch `feat/master-agent`.

**Status:** Updated after merge at `8157845`. Items marked ✅ are fixed,
🔄 are partially fixed, ❌ are still pending.

---

## 1. How the system works today

A trace of one full cycle, from a user message to committed file changes.

1. **Project creation.** `ProjectManager.create` inserts a `sessions` row,
   loads permissions from `.vajra-sandbox.json` or `.vajra-perms.json`, forks
   one long-lived sandboxed worker via `forkProjectLauncher`, creates a
   `WorkerPool`, and moves the project to status `talking`.
   See `packages/server/src/project/manager.ts:114`.

2. **Developer conversation.** Each user message routes to
   `developerConversationTurn`. On the first turn it scans the project, builds
   a summary index, reads up to five "key" files to synthesize an architecture
   blurb, and assembles a system prompt. It then runs a tool loop over
   `read_file`, `list_files`, and `search_files`, dispatching file tools to the
   single project worker.
   See `developerConversationTurn` in `packages/server/src/agent/developer.ts`.

3. **Plan proposal.** When the Developer calls `propose_plan`, the call is
   intercepted in-process and never dispatched. `parseProposePlanArgs` fills
   defaults, adds file-level dependency edges, strips cycles, computes
   "independent groups", reorders tasks, and estimates durations. Relevant code
   snippets are then inlined into each task's instructions.
   See `parseProposePlanArgs` in `packages/server/src/agent/developer.ts`.

4. **User confirmation.** Status moves to `confirming`. The web client renders
   the plan and the user confirms, optionally with edited tasks.

5. **Master orchestration.** `confirmPlan` sets status `executing` and starts
   `masterLoop` in the background. The Master wipes prior agent/task rows, loads
   the plan into a `TaskQueue`, pre-warms workers for dependency-free tasks, then
   loops: pick ready tasks, acquire file locks, launch a worker per task, and
   wait on an event-driven wake signal with a 100 ms fallback.
   See `masterLoop` in `packages/server/src/agent/master.ts`.

6. **Worker execution.** `executeTask` records original file contents for
   rollback, builds a prescriptive system prompt, and runs its own tool loop
   against a task-scoped sandboxed worker. On completion it runs the task's
   validation commands, and on failure it rolls back and retries.
   See `executeTask` in `packages/server/src/agent/master.ts`.

7. **Completion.** The Master returns a summary string, which is appended as an
   assistant message; status moves to `done`.

The shape is sound. The problems are in the details, and several of them stop
the pipeline from working at all.

---

## 2. Blockers — the pipeline cannot complete a normal plan today

These are ordered by how early they break a run.

### 2.1 A task that reads and writes the same file deadlocks forever ✅

`masterLoop` acquires a shared read lock over `task.readFile`, then an exclusive
write lock over `task.writeFile`. `FileLockManager.canAcquire` refuses a write
lock when *any* lock exists on the file, including one the same task just took.

```
const readLocksAcquired = fileLocks.tryAcquire(readFiles, task.id, 'read')   // master.ts:277
const writeLocksAcquired = fileLocks.tryAcquire(writeFiles, task.id, 'write') // master.ts:297
```

A planner that lists `src/api.ts` in both `readFile` and `writeFile` — the
overwhelmingly common case, and exactly what the Developer prompt encourages —
produces a task that can never become assignable. The outer loop does not break,
because `readyTasks.length > 0`, so the Master spins at 100 ms forever and the
project hangs in `executing`.

**Fix.** Make lock ownership re-entrant: `canAcquire` must ignore locks already
held by the requesting owner, and upgrading a read lock to a write lock for the
same owner must be allowed. Simpler alternative: compute the write set first,
subtract it from the read set, and take one lock per file at the strongest mode
the task needs.

**Applied:** `file-locks.ts` now accepts `owner` parameter on `canAcquire`/`tryAcquire`; same-owner locks are re-entrant; read→write upgrade supported; `releaseAll` maintains reverse index + notifies waiters.

### 2.2 Workers are denied `run_command`, so every validation fails ✅

`computeToolPermissions` returns file tools only; `run_command` is never in the
default list.

```
const tools = ['read_file', 'list_files', 'search_files']   // master.ts:903
```

The sandboxed worker rejects any tool outside `allowedTools` with
`Tool 'run_command' is not permitted for this worker`
(`packages/server/worker/sandboxed-worker.mjs`). Validation calls
`handle.callTool('run_command', ...)` (`master.ts:717`), so every task with a
validation command fails, rolls back, retries twice, and is marked failed.

**Fix.** Add `run_command` to the default tool set, or split validation onto a
separate Master-owned worker that holds `roleTools.master`.

**Applied:** `roleTools.worker` in `packages/protocol/src/tools.ts` now includes `run_command`.

### 2.3 Pooled worker reuse silently defeats per-task sandboxing 🔄

This is the most serious issue in the system.

`WorkerPool.acquire` matches idle workers on `projectDir` alone:

```
const reuseIndex = this.idle.findIndex(
  (w) => w.job.projectDir === job.projectDir,
)   // pool.ts:111
```

But a worker applies its Landlock/Seatbelt ruleset once, at startup, from that
task's `PermissionsConfig`. The README states the invariant plainly:
`applySandbox` confines the calling process irreversibly.

So a worker sandboxed for task A's file set gets handed to task B. Two things
follow, both wrong:

- **Over-permission.** Task B inherits write access to task A's files, which the
  plan never granted it. The per-task permission scoping that the whole design
  rests on is not enforced.
- **Under-permission.** Task B cannot write its own files, because they were not
  in A's ruleset. Every write fails with `EACCES`.

**Fix.** Key pooled workers on the full permission identity, not the directory:
hash `{projectDir, permissions, allowedTools, fileRules}` and only reuse on an
exact match. Given that plans rarely repeat an identical file set, the honest
move is to disable reuse for master-launched workers and keep the pool purely as
a concurrency semaphore.

**Applied:** Worker pool now uses string UUIDs for worker IDs (`randomUUID()`). However, workers are still reused on `projectDir` only — the recommendation to key on full permission identity or disable reuse for master-launched workers is not yet implemented.

### 2.4 Rollback resolves paths against the server's working directory ✅

`ChangeHistory.recordBefore` and `rollback` call `readFile`/`writeFile`/`unlink`
on the path as given (`packages/sandbox/src/change-history.ts:29`). Task paths
are project-relative. The server process almost never runs with `cwd` set to the
project directory.

Consequences: originals are recorded as `null` (file "not found"), so rollback
*deletes* files it should restore — and it deletes them relative to the server's
cwd, meaning it can unlink unrelated files that happen to match the relative
path.

**Fix.** Thread `projectDir` into `ChangeHistory` and resolve every path through
it, with a guard that refuses any resolved path outside the project root.

**Applied:** `ChangeHistory` constructor now accepts optional `projectDir`, resolves all paths through it, and guards against path traversal outside the project root.

### 2.5 Validation passes and fails on string matching against stdout ✅

```
const hasFailPatterns = /\b(failed|failure|error|exception|panic)\b/i.test(output)
if (hasExitCode || (hasFailPatterns && !startsWithError)) {   // master.ts:728
```

Three problems in four lines. A passing test suite that prints `0 failures`
fails validation. A compiler warning containing the word `error` fails
validation. And the `!startsWithError` clause inverts the intent: output that
*starts* with "error" is treated as a pass.

Meanwhile the real signal is already available — `run_command` throws on a
non-zero exit, and the `catch` below already handles that correctly.

**Fix.** Delete the heuristic. Have `run_command` return a structured
`{ exitCode, stdout, stderr }` and branch on `exitCode !== 0`. The current
`throw`-on-failure contract also loses stdout for successful-but-noisy commands.

**Applied:** Validation now uses structured `exitCode` check instead of regex pattern matching. CLI `run_command` uses `spawn` with `shell: false` and returns `{ exitCode, stdout, stderr }`.

### 2.6 `confirmPlan` without an API key hangs the project forever ✅

```
if (apiKey) {   // manager.ts:450
```

Status is set to `executing` before this check. When `apiKey` is absent there is
no `else`: no master loop, no event, no error. The project sits in `executing`
with no workers and no way out.

**Fix.** Validate the key before the status transition and fail loudly.

**Applied:** `confirmPlan` now validates `apiKeys` before setting status to `executing`. If no keys are provided, it sets status to `failed` and emits `projects.failed` with an error message.

---

## 3. Critical — correctness and safety

### 3.1 `run_command` uses a shell, contradicting a stated security invariant ✅ (CLI only)

`packages/protocol/src/tools.ts` opens with: *"run_shell is deliberately not
offered — run_command (argv-based, no shell) covers file-editing tasks without
the shell-injection surface."* The worker implements it as:

```
const stdout = execSync(cmd, { cwd, timeout, ... })
```

`execSync` with a string runs `/bin/sh -c`. The shell-injection surface the
comment claims to have removed is fully present, and it is reachable from
model-authored validation and `skipIf` strings.

**Fix.** Use `spawnSync` with a parsed argv and `shell: false`, or expose the
Rust core's `runCommand`, which the README already describes as "no shell". If
shell semantics are genuinely needed, name the tool honestly and gate it.

**Applied:** CLI `run_command` now uses `spawn` with `shell: false` and parsed argv. Server-side validation still uses the same path (worker sandbox).

### 3.2 `execSync` blocks the worker event loop, defeating every timeout ✅ (CLI only)

While `execSync` runs, the worker cannot process IPC, cannot respond to health
checks, and cannot fire the `maxCpuTimeMs` watchdog timer — the watchdog is a
`setTimeout`, and timers do not run during a blocking call. A validation command
that hangs takes the worker with it, silently, past every configured limit.

**Fix.** Move to async `spawn` with an explicit kill timer, and keep the IPC
channel responsive.

**Applied:** CLI `run_command` now uses async `spawn` with timeout. Server-side still uses the worker sandbox path.

### 3.3 Validation commands inherit the task's narrow sandbox

Child processes inherit Landlock restrictions. A worker confined to
`src/api.ts` + parent directories runs `npm test`, which needs to write
`node_modules/.cache`, `.turbo`, `target/`, and temp files. Validation therefore
fails for reasons unrelated to the code change.

**Fix.** Run validation in a separately launched worker whose ruleset grants the
project root read-write plus the usual cache directories, and keep the *editing*
worker narrow. This also resolves 2.2.

### 3.4 Speculative execution bypasses file locking entirely — and is dead code

The speculative branch pushes tasks straight into `assignable` without ever
calling `tryAcquire` (`master.ts:366`). If it fired, two workers could write the
same file concurrently with no coordination.

It cannot fire, though: the candidate filter starts from `queue.getReadyTasks()`
and then requires `t.dependsOn.length > 0` with a dependency still running.
`getReadyTasks` already excludes any task whose dependencies are incomplete, so
the filter is always empty.

**Fix.** Either delete the feature and its rollback bookkeeping, or rebuild it
properly: draw candidates from pending (not ready) tasks, acquire locks on the
same path as normal assignment, and execute against a copy-on-write overlay so
a wrong guess costs nothing.

### 3.5 Conversation compression destroys history and breaks tool-call pairing ✅

Two separate defects in `compressMessages` (`packages/server/src/agent/context.ts`):

- **Pairing.** It keeps the system prompt plus the last six messages. If message
  `n-6` is a `tool` result whose parent assistant `tool_call` message fell
  outside the window, both Anthropic and OpenAI reject the request. It also
  splices a synthetic `user` message in at index 1, which can land between an
  assistant tool call and its result.
- **Destruction.** Callers then overwrite the real history with the compressed
  copy:
  ```
  messages.splice(0, messages.length, ...compressedMessages)   // developer.ts and master.ts, both tool loops
  ```
  The original turns are gone permanently. Compression is meant to be a
  per-request view, not a mutation of the session record.

**Fix.** Return a derived array and never write it back. Compress in
tool-call-complete units: drop an assistant message only together with all of
its tool results. Prefer truncating tool payloads over dropping turns.

**Applied:** Upstream block-based compression (`MessageBlock`) handles tool-call pairs atomically. CLI `compressMessages` removes orphaned tool results and truncates payloads instead of dropping turns.

### 3.6 Dependency context is assembled from messages nobody writes ✅

`gatherDependencyContext` looks for a completed dependency's summary:

```
SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content LIKE ?
```

No code path ever persists a per-task worker summary. The only assistant row
matching `%task-1%` is the serialized plan JSON, whose `.summary` field is
undefined — so `summary` stays empty and dependent workers receive only a title,
a status, and a file list.

This undercuts the core premise of the design: task B is supposed to learn what
task A actually did.

**Fix.** Persist each worker's final message to `agent_messages` (the table
already exists and is otherwise unused), keyed by `task_id`, and read from there.

**Applied:** `gatherDependencyContext` now uses an in-memory `taskSummaries` map instead of a database `LIKE` query. Worker summaries are collected during execution and passed to dependent tasks.

### 3.7 Resumed conversations are malformed

`ProjectManager.attach` rebuilds history from the database
(`manager.ts:275`) and gets two things wrong:

- `arguments` is assigned a parsed object, while `ChatMessage.toolCalls[].arguments`
  is a JSON **string** everywhere else (`parseToolCall` calls `JSON.parse` on it).
- Tool *results* are never restored as `role: 'tool'` messages; only a
  `toolCallId` is attached to the assistant message.

After any page refresh, the reconstructed conversation contains tool calls with
no matching results, which providers reject outright.

**Fix.** Persist and restore tool results as first-class messages, and keep
`arguments` serialized.

### 3.8 The plan advertises capabilities that do not exist

`propose_plan` accepts `deleteFile` and `createDir`, the Developer prompt
documents them, and `computeToolPermissions` grants `delete_file` and
`create_dir` (`master.ts:909`, `master.ts:912`). Neither tool exists in `toolDefinitions`, and
neither is in `roleTools.worker`.

A plan that deletes a file or creates a directory is accepted, shown to the user,
executed, and silently does nothing.

**Fix.** Implement `delete_file` and `create_dir` as real tools with sandbox
rules, or remove the fields from the schema and the prompt.

### 3.9 Stopping a project does not stop the Master 🔄

`ProjectManager.stop` kills the project handle and drains the pool, but
`masterLoop` holds its own worker handles and has no cancellation path. There is
no `AbortSignal` threaded into `streamChat` or `executeTask`. After a "stop", LLM
calls remain in flight and workers keep writing to the user's files.

**Fix.** Create an `AbortController` per master run, store it on the project,
pass the signal into every provider call and tool dispatch, and await
termination in `stop`.

**Applied:** Anthropic provider now has `AbortController` + idle timeout wrapping. However, `AbortSignal` is not yet threaded into all provider calls (Zen, OpenRouter) or tool dispatch. The `stop` method does not yet await termination.

### 3.10 No crash recovery; a restart strands every running project

`masterLoop` begins by deleting all tasks, agents, and agent messages for the
project (`master.ts:160`). `TaskQueue.addTask` persists only `title`,
`description`, `status`, and the two permission blobs — instructions, file lists,
validation, dependencies, type, retries, and timeouts are in-memory only.

A server restart therefore leaves projects stuck in `executing` with no way to
resume or even report what was in flight, and `attach` throws
`No worker handle for project`.

**Fix.** Persist the full task record, reconcile `running`/`assigned` rows to
`pending` on boot, and either resume or explicitly fail projects whose master
process is gone.

---

## 4. High — behaviour that degrades output quality

### 4.1 Retries repeat the identical prompt ✅

On validation failure, `executeTask` rolls back and calls `queue.retryTask`
(`master.ts:774`). The next attempt rebuilds the same system prompt from the same
task, with no knowledge of why the previous attempt failed. The worker
reproduces the same mistake, twice, then the task is marked failed.

**Fix.** Append the failing command and its output to the retry prompt, and
consider escalating the model or widening the tool set on the final attempt.

**Applied:** Worker prompt now includes previous validation failure output on retry. The retry context is read from the `tasks` table and appended to the system prompt.

### 4.2 `retries` from the plan is discarded ✅

The protocol field is `retries` (`packages/protocol/src/messages.ts`), the queue
reads `task.maxRetries` (`taskqueue.ts`), and the Master reads
`task.maxRetries ?? DEFAULT_MAX_RETRIES` (`master.ts:758`). The names never meet,
so a planner-specified retry count is always ignored and every task gets 2.

**Fix.** Pick one name and use it across the protocol, queue, and master. A
compile-time mapping rather than two structurally similar interfaces would have
caught this.

**Applied:** `taskqueue.ts` now imports `PlannedTask` from protocol and reads `task.retries` directly. No more `maxRetries` mismatch.

### 4.3 `skipIf` is inverted and half-disabled ✅

```
if (trimmed.toLowerCase().startsWith('file exists:')) {
  try { await access(fullPath); continue }   // exists → keep checking → do NOT skip
  catch { return true }                      // missing → skip
}
```

`file exists: X` skips when X is **missing**. The documented meaning is the
opposite. Separately, `evaluateSkipIf` is called without a handle
(`master.ts:319`), so both `command passes:` and `command fails:` conditions fall
through and never evaluate.

**Fix.** Correct the polarity, add a test per condition kind, and pass a handle
so command conditions work — or drop them from the schema.

**Applied:** `evaluateSkipIf` polarity fixed in both CLI and server. `file exists:` returns true when found, `file missing:` returns true when not found. AND logic for all conditions.

### 4.4 Worker resource limits are never applied

`WorkerJob` carries `resourceLimits`, `MasterInput` carries `resourceLimits`, and
`executeTask` reads `resourceLimits?.maxToolCalls`. Nothing populates it:
`confirmPlan` does not set it on `MasterInput`, and the master's `launchWorker`
calls omit it. Every configured limit — memory, CPU time, tool calls, spawn
retries — is inert.

**Fix.** Resolve limits once from config and thread them through both call sites.

### 4.5 Parallel workers stream into one undifferentiated text channel

Every worker emits `projects.assistantDelta` with only `{ text }`
(`master.ts:669`). With four workers running, the UI receives four token streams
interleaved character by character into a single chat bubble.

**Fix.** Add `agentId` and `taskId` to delta events and render per-worker panes.
`WorkerStatus.tsx` already has the shape to host this.

### 4.6 "Independent groups" are not independent

The grouping loop in `parseProposePlanArgs` (`parseProposePlanArgs`) marks tasks as
assigned while iterating, so a task whose dependency was just assigned joins the
*same* group. In practice nearly every task lands in group 0, dependencies and
all.

Downstream this corrupts two things: `estimatedWorkers` reported to the user, and
`maxConcurrentWorkers = Math.min(adaptiveMax, plan.independentGroups[0]?.length)`
(`master.ts:203`).

**Fix.** Compute proper topological levels: group *n* is every task whose
dependencies all sit in groups `< n`. That is the number the UI should show.

### 4.7 Blocked tasks emit a conflict event ten times a second

The assignment loop re-evaluates every ready task on each 100 ms tick and pushes
`projects.conflictDetected` each time a lock is unavailable
(`master.ts:284`, `master.ts:304`). One blocked task generates roughly 600 events
per minute over the WebSocket.

**Fix.** Track which conflicts have been reported and emit on transition only,
paired with a `conflictResolved` event when the lock clears. The protocol already
declares that event; nothing emits it.

### 4.8 `FileLockManager.releaseAll` leaves the reverse index stale ✅

```
releaseAll(owner: string): string[] {   // file-locks.ts:228
```

It walks `this.locks` and splices, but never touches `this.ownerFiles` and never
notifies waiters. After the write-lock failure path calls it (`master.ts:299`),
`hasLocks(owner)` reports true for an owner holding nothing, and anyone in
`waitForRelease` is not woken.

**Fix.** Make `releaseAll` delegate to `release`, which already maintains both
structures and notifies waiters. The class currently has five overlapping
release methods — `release`, `releaseFiles`, `releaseFile`, `releaseAll`,
`drain`, `clear` — with subtly different bookkeeping. Collapse them.

**Applied:** `releaseAll` now maintains the reverse index (`ownerFiles`) and notifies waiters. Re-entrant same-owner locks are supported.

### 4.9 Pool slot accounting drifts, and a drained pool is permanently dead

- `notifyWaiter` hands an idle worker to a waiter without decrementing
  `availableSlots`; `acquire` then stops that worker and forks a new one
  (`pool.ts:126`). Net worker count is unchanged but the slot counter is not.
- `drain()` sets `availableSlots = 0` with no reset path, so a pool reused after
  a drain never grants another slot.

**Fix.** Make slot accounting a single explicit semaphore with acquire/release
symmetry, and have `drain` return the pool to a constructed state.

### 4.10 The pool health check is an empty loop

```
const interval = setInterval(() => {
  try {
    // ... comment only, no statements
  } catch { ... }
}, 30_000)   // pool.ts:398
```

It cannot detect anything. Meanwhile `WorkerHandle` already tracks a `dead` flag
that the pool never consults, so a crashed worker stays in the idle list and is
handed to the next caller, failing every call it receives.

**Fix.** Expose `isAlive()` on `LaunchHandle`, check it on acquire and release,
and implement the heartbeat as a real IPC ping with a timeout.

---

## 5. Medium — cost, latency, and fidelity

### 5.1 Context is delivered twice

The Developer inlines extracted code into each task's instructions
(`developerConversationTurn`, plan-context injection), and the worker prompt then instructs: *"Read each readFile
first to understand the current code"* (`master.ts:642`). The worker re-reads
what it was already given. Every task pays for the same content twice.

**Fix.** Pick one. Inlined context is cheaper and more deterministic; if you keep
it, tell the worker the content is already present and to read only what is
missing.

### 5.2 `extractRelevantLines` injects noise

It scans for `function|class|const|let|var|async` followed by a name, then marks
every line in the file containing that bare substring (`extractRelevantLines`). An
instruction mentioning `const handler` pulls in every line containing "handler".
When nothing matches it falls back to the first 50 lines, which for most source
files is imports.

The declared constant `MAX_CONTEXT_LINES` is imported but the literal `50` is
hardcoded instead.

**Fix.** Anchor on symbol definitions rather than substring occurrences, and
extract the enclosing block. The summary index already extracts symbols; reuse
that machinery instead of a second ad-hoc regex pass.

### 5.3 Architecture pre-analysis costs five IPC file reads for low value

Before the Developer answers the user's first message, `analyzeArchitecture`
reads five files and reduces each to its first five `import` and `export` lines
(`analyzeArchitecture`). The summary index already carries import and export counts
plus symbol lists, so this mostly restates what the prompt contains.

**Fix.** Drop it, or replace it with a cached, project-level artifact computed
once and invalidated on file change.

### 5.4 Task duration estimates are invented

`estimateTaskDurations` multiplies a hardcoded 30/120/240-minute base by a file
count ratio and a validation count ratio (`estimateTaskDurations`). These numbers
reach the user as estimates. They have no relationship to anything measured.

**Fix.** Either remove the field or derive it from recorded historical task
durations, which the `tasks` table already has the columns to support
(`started_at`, `completed_at`).

### 5.5 `totalToolCalls` is always zero, and there is no cost accounting

`MasterResult.totalToolCalls` is declared, returned, and never incremented —
`executeTask` counts locally and discards the count. More broadly there is no
token or spend tracking anywhere in the system: no usage capture from providers,
no per-task budget, no ceiling on a runaway plan.

**Fix.** Return per-task tool-call and token counts from `executeTask`, aggregate
them, persist to `tasks`, and add a configurable per-plan budget that halts
execution when exceeded.

### 5.6 Summary index caps at 16 KB, silently

`buildSummaryIndex` breaks out at `MAX_SUMMARY_TOTAL_SIZE` (16000 chars) with no
signal. On any real repository the Developer sees an arbitrary alphabetical
prefix of the file list and has no idea the rest exists.

**Fix.** Rank before truncating (entry points, high fan-in, recently modified),
and tell the Developer in the prompt how many files were omitted so it knows to
use `search_files`.

### 5.7 Model context limits are a hardcoded table

`MODEL_LIMITS` in `context.ts` enumerates specific model ids and falls back to
128000. Any model not listed — including most Anthropic models — silently gets
the default, which is wrong in both directions.

**Fix.** Have each provider report its own context window, and treat the table as
a fallback only.

### 5.8 Sequence numbers are allocated non-atomically

`nextSeq` does a `SELECT MAX(seq) + 1` and `appendMessage` does a separate
`INSERT` (`packages/server/src/agent/utils.ts`). Two concurrent writers compute
the same value and the second violates `PRIMARY KEY (session_id, seq)`.

**Fix.** Wrap the pair in a `better-sqlite3` transaction, or drop the manual
counter in favour of an autoincrement id with a separate ordering column.

### 5.9 `allowUnenforced` is inconsistent between project and workers

`create` honours `input.allowUnenforced`, but every master-launched worker
hardcodes `allowUnenforced: false` (`manager.ts:477`, `manager.ts:488`). On a
platform with no sandbox support — Windows, per the README — the project starts
and the conversation works, then every worker refuses to launch at execution
time.

**Fix.** Carry the project's setting through to worker launches, and surface the
consequence in the plan-confirmation UI.

### 5.10 Master-launched workers get no file-rule enforcement

`checkToolPermission` in the worker runs only when `fileRules.length > 0`. The
master's `launchWorker` passes `permissions` but never `fileRules` or
`defaultFilePermissions` (`manager.ts:473`), so that in-process check is skipped
entirely and enforcement rests solely on the OS sandbox.

That is not fatal where Landlock or Seatbelt is active. It is fatal on Windows,
and it removes the defence-in-depth layer the worker comment describes.

**Fix.** Derive file rules from the task's permission config and pass them
through on every worker launch.

### 5.11 `sendMessage` during execution starts a competing agent loop

Status `executing` falls through to the legacy `sendWorkerMessage` path
(`manager.ts:420`), which launches an independent `agentLoop` against the project
handle while the Master is mid-run. Two uncoordinated agents then edit the same
tree.

**Fix.** Reject or queue user messages while `executing`, and route them to the
Master as guidance rather than to a parallel agent.

### 5.12 Skipped tasks are counted as completed

`queue.skipTask` is followed by `completedTasks.push(task.id)`
(`master.ts:323`), so the final summary — *"Completed N of M tasks"* — includes
work that was deliberately not done.

**Fix.** Track skipped separately and report all three counts.

---

## 6. Low — dead code, duplication, and hygiene

### 6.1 Substantial dead code in the hot path

- `TaskQueue.getSmartBatches`, `getParallelBatches`, `canRunInParallel`,
  `hasConflict`, `getLockedFiles`, `getTaskFiles` — none are called. The Master's
  comment claims it uses "smart batching for cache efficiency"; it calls
  `getReadyTasks()`.
- `compressSummaryByRelevance` and `formatSummaryIndex` are imported in
  `developer.ts` and unused. `DEFAULT_VALIDATION_TIMEOUT` is imported in
  `master.ts` and unused. `randomUUID` is imported in `taskqueue.ts` and unused.
- `identifyKeyFiles(summary, tree)` ignores `tree`; `analyzeArchitecture` and
  `readTaskContext` ignore `projectDir`; `extractRelevantLines` ignores
  `filePath`; `compressMessage` in `context.ts` is never called.

**Fix.** Delete it. Unused parameters that look meaningful are worse than absent
ones — `readTaskContext(projectDir, ...)` reads as though it resolves paths, and
that is exactly the bug in 2.4.

### 6.2 The CLI duplicates the server's agent stack

`packages/cli/src/agent/` carries its own `developer.ts` (481 lines),
`taskqueue.ts` (276), `summary.ts` (262), `registry.ts`, `tools.ts`, and
`tree.ts` — near-copies of the server versions, already diverged. The CLI copy
has no master, no context compression, and is hardwired to OpenRouter.

Every fix in this document must currently be applied twice, and the copies will
keep drifting.

**Fix.** Extract the shared agent core into a package both consume. The provider
abstraction in `packages/server/src/agent/providers/` is the natural seam.

### 6.3 Push event names and payloads do not match the protocol

`PushEventPayloads` declares `session.*` events. The server pushes `projects.*`
and the web client subscribes to `projects.*`. Because `PushEvents.push` takes
`event: string`, nothing type-checks the connection, and the declared payload
types are decorative.

Payload shapes disagree too: the protocol declares
`session.workerProgress: { sessionId, agentId, task, detail }`; the server sends
`{ projectId, agentId, taskId, detail }`.

**Fix.** Rename the protocol entries to `projects.*`, make `push` generic over
`PushEventName` with a payload type parameter, and let the compiler find the
mismatches.

### 6.4 The `agent_messages` table has no implementation

The schema documents an inter-agent message bus with `message_type` values for
`task_assigned`, `task_completed`, `conflict_detected`, and `coordination`.
Nothing writes to it, and `masterLoop` deletes from it at startup. This is the
right table for the per-task summaries that 3.6 needs.

### 6.5 Schema is missing columns the code assumes

`tasks` has no `retries`, `timeout`, `rollback`, `skip_if`, `instructions`,
`read_file`, `write_file`, `validation`, or `type` column, yet `TaskState`
carries all of them. `sessions.status` comments list the old status values and
omit `talking` and `confirming`.

### 6.6 No tests cover the orchestration path

The test suite covers the sandbox, file locks, tool dispatch, the single-agent
loop, and the database. There is not one test for `master.ts`, `developer.ts`,
`taskqueue.ts`, `context.ts`, or `pool.ts` — the five files where every blocker
in section 2 lives.

**Fix.** Start with the cases that would have caught the blockers:

- a task with the same file in `readFile` and `writeFile` reaches `running`
- a default-permission task can execute its validation command
- a pooled worker is not reused across differing permission sets
- rollback restores a modified file to its original content at the right path
- a validation command printing "0 failures" passes
- `compressMessages` never returns a tool result without its parent tool call

---

## 7. Architectural recommendations

Beyond fixing defects, four structural changes would raise the ceiling on what
this system can do.

### 7.1 Execute on an isolated copy, not the user's working tree

Workers write directly to the live project. Rollback is a best-effort
file-content restore held in process memory, lost on crash. A partial failure
leaves a half-edited tree with no record of what changed.

Give each task a git worktree or an overlay directory. Validate there, then merge
successful tasks back. Rollback becomes discarding a directory, conflicts become
merges the Master can reason about, and the user gets a reviewable diff before
anything touches their checkout. This also makes speculative execution safe and
removes most of the file-locking machinery.

### 7.2 Make the Master an actual agent

The Master is currently a scheduler with an LLM provider it never calls. It
cannot re-plan when a task fails, cannot split a task that proves too large,
cannot reassign work, and cannot answer a worker's question.

Give it a real tool loop with tools such as `get_task_status`, `retry_task`,
`amend_task`, `split_task`, and `abort_plan`, invoked when a task fails or
validation reveals something the plan did not anticipate. That is the difference
between a task runner and an orchestrator.

### 7.3 Let the Developer verify its own plan before proposing it

The Developer emits a plan with no check that referenced files exist, that paths
sit inside the project, that validation commands are runnable, or that the
dependency graph makes sense. The cycle-removal pass silently strips *all*
dependencies from every task in a cycle (`detectAndRemoveCircularDeps`), which can turn a
correct sequential plan into a parallel one that corrupts files.

Add a validation pass before `planProposed`: resolve every path, reject traversal
outside the project root, confirm validation commands exist on `PATH`, and
surface cycle removal to the user instead of silently rewriting the graph.

### 7.4 Separate the transport channel per agent

One project-wide event stream forces the UI to guess which agent produced what.
Every event from a worker should carry `agentId` and `taskId`, and the client
should be able to subscribe per agent. This is a precondition for a usable
parallel-execution view and for per-worker cost reporting.

---

## 8. Suggested sequencing

**First — make one plan run end to end.** 2.1 (lock self-deadlock), 2.2
(`run_command` permission), 2.3 (pool reuse; disable reuse as the immediate
mitigation), 2.4 (rollback paths), 2.5 (validation detection), 2.6 (missing API
key). Add the six regression tests from 6.6 alongside.

**Status:** 2.1 ✅, 2.2 ✅, 2.3 🔄, 2.4 ✅, 2.5 ✅, 2.6 ✅

**Second — make it safe.** 3.1 and 3.2 (shell and blocking `execSync`), 3.3
(validation sandbox), 3.9 (cancellation), 5.10 (file rules on worker launch),
3.4 (delete speculative execution).

**Status:** 3.1 ✅ (CLI), 3.2 ✅ (CLI), 3.3 ❌, 3.9 🔄, 5.10 ❌, 3.4 ❌

**Third — make it correct over time.** 3.5 (compression), 3.6 (dependency
context), 3.7 (resume), 3.10 (persistence and crash recovery), 4.1 and 4.2
(retries).

**Status:** 3.5 ✅, 3.6 ✅, 3.7 ❌, 3.10 ❌, 4.1 ✅, 4.2 ✅

**Fourth — make it observable.** 4.5 (per-agent streams), 4.7 (event
deduplication), 5.5 (cost accounting), 6.3 (typed events).

**Status:** All ❌

**Fifth — restructure.** 7.1 (worktree isolation) first, since it retires a large
amount of the locking and rollback code, then 7.2, 7.3, and 6.2 (deduplicate the
CLI).

**Status:** All ❌

---
---

# Part II — Deep pass

The first pass followed the orchestration path. This pass goes down into the
layers it rests on: the Landlock ruleset the Rust core actually installs, the
three LLM providers, credential routing, the transport, and the registries that
disagree with each other.

Several findings here supersede first-pass items by explaining a deeper cause.
Where that happens it is noted.

---

## 9. The sandbox denies the operations the plan is built around

This section is the most important in either pass. The per-task permission model
that the Master computes cannot express what a worker needs, and the Landlock
ruleset the core installs denies the three most common task types outright.

Relevant code: `computeTaskPermissions` in `packages/server/src/agent/master.ts`,
`apply_per_file_rules` and `perms_to_bits` in
`packages/core/src/sandbox/linux/permits.rs`.

### 9.1 A `create` task cannot create its file ✅

`computeTaskPermissions` grants the target file `{read, write, edit}` and then
grants each parent directory read-only:

```
if (!files[dir]) {
  files[dir] = { read: true, write: false, edit: false, delete: false }
}
```

Landlock decides file *creation* from rights on the parent directory, not the
file. `perms_to_bits` only emits `MAKE_REG`/`MAKE_DIR`/`MAKE_SYM` for a
directory when `perm.write` is true. The parent has `write: false`, so no
creation right is granted.

Worse, the file itself never gets a rule at all. `apply_per_file_rules` builds
rules by walking the directory tree — it can only add a rule for a path that
already exists on disk. A file the task is about to create is invisible to that
walk.

So every task of type `create` fails at the first `write_file`. This also means
a worker cannot read back a file it just wrote.

**Fix.** Grant `write` on the parent directory of any path in `writeFile` or
`createDir`. Longer term, stop deriving OS rules from a directory walk: grant
the write set at directory granularity and let the in-process file-rule check
do path-level precision.

**Applied:** `computeTaskPermissions` now grants `write` on parent directories of `writeFile` entries. Both server and CLI implementations updated.

### 9.2 A `delete` task cannot delete its file

Same mechanism. `computeTaskPermissions` sets `delete: true` on the file, and
`perms_to_bits` emits `REMOVE_FILE` for it. But unlinking requires `REMOVE_FILE`
on the *parent directory*, which is granted `delete: false`.

This is independent of the first-pass finding that `delete_file` is not a real
tool. Even after that tool exists, the sandbox will refuse the call.

### 9.3 `node_modules`, `.git`, and `target` are unreadable to every worker

`should_skip_dir` excludes those three directories from the rule walk:

```
matches!(name, ".git" | "node_modules" | "target")
```

With a per-task `PermissionsConfig` whose `default` is all-false, the root grant
is `EXECUTE` only, and a skipped directory inherits exactly that. So:

- `npm test`, `tsc`, `eslint`, `vitest` cannot read their own dependencies.
- Any `rollback` command starting with `git` cannot read `.git`.
- Rust validation cannot read `target`.

This supersedes first-pass item 3.3. The problem is not that validation needs
extra write access for caches. It is that validation cannot read the toolchain
at all.

### 9.4 Symlinks are skipped, which breaks pnpm entirely

```
if file_type.is_symlink() { continue; }
```

This repository is a pnpm workspace. Under pnpm, nearly everything in
`node_modules` is a symlink into the content-addressed store, and workspace
packages are symlinks to sibling directories. Skipping symlinks means those
paths get no rule and fall back to the root grant.

Refusing to *follow* symlinks when enumerating is correct — it prevents a
symlink from smuggling in a rule for a path outside the project. Refusing to
*grant* the symlink itself is what breaks. Resolve the link, confirm the target
is inside an already-permitted root, and grant accordingly.

### 9.5 Rules stop at depth 8, silently

The walk is bounded by `MAX_DEPTH = 8`. Anything deeper receives no explicit
rule and inherits the root grant. Under a restrictive default that means
unreadable. Nothing reports this; the `notes` vector carries a warning only for
the narrowed-rights case.

**Fix.** Emit a warning listing how many paths were skipped for depth, and
surface it in the sandbox report the UI already displays.

### 9.6 Glob-based configs install no per-file OS rules at all

`resolveFilePermissions` in `packages/sandbox/src/file-rules.ts` returns:

```
return { version: 1, default: { ...config.defaultPermissions }, files: {} }
```

The comment is candid about it: rules are left for the worker to evaluate per
call. But the worker only evaluates them when `fileRules.length > 0`, and the
Master's `launchWorker` never passes `fileRules` (first-pass item 5.10).

Chain the two together for a project using `.vajra-sandbox.json`:

1. The OS ruleset enforces only `defaultPermissions`, which defaults to
   `read: true` for the whole project.
2. The in-process glob check, which is where `!*.env` style rules live, is
   skipped for every master-launched worker.

The result is that a rule written specifically to hide secrets from the agent
does not hide them. That is the exact scenario the README names as the reason
the project exists.

**Fix.** Pass `fileRules` and `defaultFilePermissions` on every worker launch,
and additionally materialize glob rules into concrete per-path entries at launch
time so the OS layer enforces them too.

### 9.7 Nothing confines the network

Landlock ABI 4 can restrict TCP bind and connect. The core handles filesystem
access only, and the macOS Seatbelt profile is not consulted for network either.
A worker with `run_command` can `curl` the entire repository to an external host,
and the agent's own model calls are indistinguishable from exfiltration at this
layer.

For a tool whose stated purpose is letting an agent work on code without reading
secrets, unrestricted egress is a material gap. It deserves an explicit position
in `SECURITY.md` even if the answer is "out of scope for now".

### 9.8 `/proc` read access undoes the environment allowlist

`forkProjectLauncher` carefully strips the environment down to a seven-entry
allowlist so the worker never sees `ANTHROPIC_API_KEY`. The Landlock ruleset then
grants `/proc` read access:

```
("/etc", ro), ("/proc", ro), ("/dev", rw),
```

A same-uid process reading `/proc/<pid>/environ` recovers the parent's
environment, including every API key — subject to the host's
`yama/ptrace_scope`, which is not something the sandbox controls or checks.

`/dev` is granted the full `rw` bit set, which includes `MAKE_REG`, `MAKE_DIR`,
`REMOVE_FILE`, and `REMOVE_DIR`. The worker needs `/dev/null` and
`/dev/urandom`, not the ability to create and delete entries in `/dev`.

**Fix.** Narrow `/proc` to the specific entries a toolchain needs, or drop it and
see what breaks. Narrow `/dev` to individual device files with read/write only.
Check `ptrace_scope` at startup and include the result in the sandbox report.

### 9.9 The permission model cannot express what a task needs

Stepping back from individual bugs: the model is a map from exact path to four
booleans, derived from a directory walk at a single instant. A real task needs

- write access to files that do not exist yet,
- read access to a toolchain it cannot enumerate in advance,
- write access to build caches it does not know the location of,
- and read access through symlinks.

None of those are expressible. Every finding in this section is a symptom of
that one mismatch. The worktree-isolation recommendation from first-pass 7.1
resolves it cleanly: give the worker full write access to its own scratch copy,
grant the toolchain read-execute, and enforce task scoping by diffing the result
rather than by pre-authorizing paths.

---

## 10. The provider layer

### 10.1 The Anthropic retry loop cannot fire ✅

```
stream = client.messages.stream(params) as unknown as AsyncIterable<unknown>
break
```

`messages.stream()` returns a stream object synchronously; it does not throw for
HTTP errors. Those surface while iterating, which happens after the `try` block
has exited. So the `isOverloadedError` retry — the only 529 handling in the
provider — is unreachable.

`OpenRouterProvider` does `await client.chat.completions.create(...)` inside the
try, so it catches connection-time errors, but a mid-stream failure still
escapes. Only `ZenProvider` wraps the whole iteration.

**Fix.** Adopt the Zen structure everywhere: the retry must wrap iteration, not
just construction. Also broaden the predicates — Anthropic retries on 529 only,
ignoring 429 and 5xx.

**Applied:** Anthropic provider now has upstream structure with `AbortController`, retry wrapping the entire iteration, and idle timeout. Zen provider already had this structure.

### 10.2 The Zen retry replays text the user has already seen

Zen does wrap iteration, which introduces the opposite problem: `onTextDelta`
has already fired for every token received before the failure. On retry the
stream restarts from the beginning and fires again, so the UI shows the partial
response followed by the complete one.

**Fix.** Buffer deltas until the stream completes, or emit a reset event the
client can act on before replaying.

### 10.3 Token usage is captured by all three providers and discarded by every caller

`ChatResult.usage` is populated in `openrouter.ts`, `zen.ts`, and
`anthropic.ts`. Not one of `agentLoop`, `developerConversationTurn`, or
`executeTask` reads it.

And for the two OpenAI-compatible providers it is usually absent anyway, because
neither sets `stream_options: { include_usage: true }` — without that, the API
omits usage from streamed responses entirely.

This is the cheapest fix in the document for the largest observability gain: one
request parameter, one field read, one column. It turns first-pass item 5.5 from
a build into a wiring job.

### 10.4 No provider call has a timeout or an abort path

All three construct clients with no `timeout`, pass no `AbortSignal`, and expose
no cancellation. A stalled stream holds a worker slot indefinitely, and
`ProjectManager.stop` cannot interrupt it. This is the mechanism behind
first-pass item 3.9 — the cancellation gap starts here, not in the Master.

**Fix.** Add `signal` to `ChatRequest`, thread it through all three providers,
and set a per-request timeout.

### 10.5 `max_tokens` is hardcoded for Anthropic and unset elsewhere

Anthropic gets a flat `max_tokens: 16384`, which exceeds the limit for some
models and truncates output on others. OpenRouter and Zen set nothing, so each
upstream model applies its own default — for some that is small enough to cut off
a response mid-tool-call, which surfaces as unparseable tool arguments rather
than as an obvious truncation.

**Fix.** Derive from the model's known output limit, alongside the context-window
lookup that first-pass item 5.7 already calls for.

### 10.6 Anthropic thinking deltas are handled but never requested

The stream loop handles `thinking_delta`, but `params` never includes a
`thinking` block, so extended thinking is off and the handler is dead. The web
client renders a thinking pane that stays empty for Anthropic models while
working for OpenRouter reasoning models — an inconsistency users will read as a
bug in the UI.

### 10.7 Tool-call accumulation ignores the block index

```
const lastToolCall = [...toolCalls.values()].pop()
if (lastToolCall) { lastToolCall.arguments += delta.partial_json }
```

`event.index` identifies the content block the delta belongs to, and the map is
already keyed by it. Appending to the most recently inserted entry happens to be
correct while Anthropic streams blocks sequentially, and silently corrupts
arguments if that ever changes. The OpenRouter and Zen implementations key on
`fragment.index` correctly; this one should match.

### 10.8 Missing identifiers degrade into empty strings

Both OpenAI-compatible providers emit `tool_call_id: m.toolCallId ?? ''`, and the
Anthropic path emits `tool_use_id: m.toolCallId ?? ''`. An empty id is not a
recoverable state — it produces an opaque 400 from the API. Failing loudly at the
conversion boundary would make the compression and resume bugs in first-pass 3.5
and 3.7 diagnosable instead of mysterious.

---

## 11. Credential routing sends keys to the wrong vendor

### 11.1 Every agent call uses an arbitrary API key ✅

`packages/server/src/ws/handlers/projects-handler.ts`, in both `sendMessage` and
`confirmPlan`:

```
const apiKey = Object.values(ctx.apiKeys)[0]
```

This takes whichever key was inserted first — `openrouter`, then `anthropic`,
then `zen` per `index.ts` — with no reference to the project's model. The
correctly-resolved provider is constructed elsewhere and then handed this key.

With `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY` both set and a project on an
`anthropic/` model, the OpenRouter key is transmitted to `api.anthropic.com`.
The request fails, and the credential has been disclosed to a third party.

**Fix.** Resolve the key from the project's model through `parseModelString`, and
never fall back across vendors.

**Applied:** `confirmPlan` now validates `apiKeys` before starting the master loop and resolves the key from the project's model through `createProvider`. `setModel` rebuilds the provider on model change.

### 11.2 `createProvider` has the same fallback by design

```
const apiKey = apiKeys[providerName] ?? apiKeys['openrouter'] ?? ''
```

Cross-vendor fallback should not exist. A missing key for the selected provider
is an error, not an invitation to try someone else's.

### 11.3 The `go` provider can never receive its own key

`index.ts` registers `OPENCODE_API_KEY` as `apiKeys.zen`. The `go` provider looks
up `apiKeys['go']`, misses, and falls through to the OpenRouter key — which is
then sent to `opencode.ai`. The `go/` model prefix cannot work as written.

### 11.4 `setModel` changes the model but not the provider

```
setModel(projectId, model) { this.db.prepare(`UPDATE sessions SET model = ?...`) }
```

`ConversationState.provider` is set once at creation. Switching a live project
from an OpenRouter model to an Anthropic one updates the string and keeps the
OpenRouter client, so the next turn posts an Anthropic model name to OpenRouter.

**Fix.** Rebuild the provider on `setModel`, and validate the new model has a
usable key before accepting the change.

---

## 12. Transport and access control

### 12.1 Authentication is opt-in and the dangerous RPC is unguarded

`VAJRA_AUTH_TOKEN` is read from the environment, and when unset every connection
is accepted:

```
if (!AUTH_TOKEN) return true
```

The default server binds port 4820. `projects.create` accepts `projectDir` as a
free-form string with no validation — not checked for existence, not resolved,
not constrained to any base directory. The created project then runs an agent
with `run_command`.

So the default configuration gives anyone who can reach the port the ability to
create a project rooted at `/` or `$HOME` and execute commands there.

The inconsistency is instructive: `project.browse`, which only *lists directory
names*, is carefully restricted to `BROWSE_BASE_DIR`. `projects.create`, which
runs code, is not restricted at all.

**Fix.** Require a token by default and generate one on first run. Constrain
`projectDir` to an allowlist of roots, resolve it, and reject symlinks that
escape. Bind to loopback unless explicitly configured otherwise.

### 12.2 Rate limiting counts messages, not work

The limiter allows 100 messages per minute per connection. A single
`projects.create` starts a process and an unbounded chain of model calls. The
limit does not bound anything expensive.

**Fix.** Limit concurrent projects per connection and total in-flight agent runs,
separately from the message counter.

### 12.3 Events are pushed synchronously with no backpressure

`events.push` iterates subscribers and calls `ws.send` directly, with no check on
`bufferedAmount`. Several workers streaming tokens into one slow connection grow
the socket buffer without limit.

**Fix.** Drop or coalesce deltas when `bufferedAmount` crosses a threshold. The
client already throttles to 50 ms on receive; the server should coalesce on send.

---

## 13. The Developer conversation poisons itself at the tool-call budget ✅

This is a concrete failure mode that spans the loop structure and the provider
layer, and it is not covered by first-pass 3.5.

In `developerConversationTurn`, tool calls in a batch are dispatched
concurrently, and each increments a shared counter:

```
toolCallCount++
if (toolCallCount > MAX_DEVELOPER_TOOL_CALLS) return null
```

The `null` results are filtered out before being pushed to `messages`. The
assistant message holding those tool calls is already in history. So when the
budget boundary falls inside a batch, the conversation permanently contains an
assistant message with tool calls that have no matching results.

The loop then exits, so the malformed state is not sent immediately. But
`messages` is the Developer's **long-lived conversation state**, held in
`ConversationState.history` across turns. The next user message replays the whole
history — and both Anthropic and OpenAI reject a conversation with an unanswered
tool call.

The fallback path makes it worse: it appends a second assistant message
(`'I have enough context. Let me propose a plan.'`) directly after the first,
producing two consecutive assistant turns as well.

`agentLoop` and `executeTask` have the same `return null` pattern but survive it,
because their message arrays are per-run and discarded.

**Fix.** Never drop a tool result. When the budget is exhausted, still append a
result for every call — with content explaining the budget was reached. That is
both well-formed and more informative to the model than silence.

**Applied:** When tool-call budget is exhausted, synthetic error results are appended for every call explaining the budget was reached. No more dangling tool_calls in conversation history.

---

## 14. Three registries disagree about the same facts

### 14.1 Role-to-tool mapping exists in three places

| Source | Worker tools |
| --- | --- |
| `roleTools` in `packages/protocol/src/tools.ts` | read, list, search, write, edit, run_command |
| `ROLE_DEFAULTS` in `packages/sandbox/src/tool-rules.ts` | read, list, write, edit, delete_file, create_dir, copy_file, rename_file |
| `computeToolPermissions` in `packages/server/src/agent/master.ts` | read, list, search, plus write/edit or delete_file by task type |

No two agree. The sandbox copy names four tools that do not exist in
`toolDefinitions` and are silently filtered out, and omits `search_files` and
`run_command` which do. The Master's copy is what actually reaches the worker,
and the protocol's copy is what filters the specs shown to the model — which is
how a worker ends up being offered `run_command` while being denied it
(first-pass 2.2).

**Fix.** One table in the protocol package. The other two become lookups.

### 14.2 Model metadata exists in three places

`MODEL_LIMITS` in `context.ts` (context windows), `knownModels` in
`providers/index.ts` (validation), and the web `ModelSelector`. They already
disagree: the Anthropic validation set lists five models, none of which appear in
the context-window table, so every Anthropic project logs a warning on creation
and then gets the 128k default window regardless of the model's real capacity.

**Fix.** One model registry: id, provider, context window, max output, whether it
supports thinking. Provider-reported where the API offers it.

---

## 15. The execution phase is nearly invisible to the user

### 15.1 The most informative event has no subscriber

The Master emits `projects.workerProgress` for pre-warming, pre-warm results,
speculative decisions, skip decisions, validation start, rollback results, and
retry counts. `useProject.ts` subscribes to fourteen events; this is not one of
them. Every one of those messages is discarded by the client.

### 15.2 Tool activity is not reported in the multi-agent path

`agentLoop` emits `projects.toolCall` and `projects.toolResult` per call. Neither
`developerConversationTurn` nor `executeTask` emits them. So in the path the
project is named for, the user sees interleaved text with no indication of which
files are being read or written.

### 15.3 Pre-warming creates orphan agent rows

The pre-warm block calls `registry.createAgent(...)` and stores only the handle.
When the task is later assigned, the assignment path calls `createAgent` again.
The first agent is never started, never updated, and never cleaned up — it sits
in the `agents` table at status `pending` for the life of the project, and the
Master's own status queries count it.

### 15.4 Client state arrays grow without bound

`conflicts` and `agents` are appended to on every corresponding event, with no
deduplication or cap. Combined with the 10-per-second conflict spam from
first-pass 4.7, a single blocked task grows a React state array by hundreds of
entries per minute and re-renders the tree on each one.

---

## 16. There is no migration path

`openDb` executes `schema.sql` on every open, and every statement is
`CREATE TABLE IF NOT EXISTS`. An existing database is therefore never altered.

Every persistence fix this document recommends — task instructions, retries,
timeouts, per-task token counts, worker summaries — requires new columns, and
there is no mechanism to add them to a database that already exists. Users would
silently keep the old schema and the new code would fail on first write.

`busy_timeout` is also unset. With WAL and concurrent writers from the agent
path and the video handlers, a write contending with another returns
`SQLITE_BUSY` immediately rather than waiting.

**Fix.** Add a `schema_version` table and an ordered migration list applied at
open. Set `busy_timeout` to a few seconds. Do this before any of the persistence
work, because it gates all of it.

---

## 17. Revised priority

The deep pass changes the ordering. Sandbox rights (section 9) now sit alongside
the first-pass blockers, because a plan that survives the Master still fails at
the first write.

**Stage 0 — make a single task succeed end to end.**
9.1 and 9.2 (directory rights for create and delete), 9.3 and 9.4 (toolchain and
symlink readability), plus first-pass 2.1, 2.2, 2.4, 2.5, 2.6. Until these are
done, no plan completes, and no other fix is observable.

**Status:** 9.1 ✅, 9.2 ❌, 9.3 ❌, 9.4 ❌, 2.1 ✅, 2.2 ✅, 2.4 ✅, 2.5 ✅, 2.6 ✅

**Stage 1 — close the credential and access holes.**
11.1 through 11.4 (key routing), 12.1 (auth default and `projectDir`
validation), 9.6 (file rules reaching the worker), first-pass 2.3 (pool reuse).
These are small, independent, and each is a disclosure risk today.

**Status:** 11.1 ✅, 11.2 ❌, 11.3 ❌, 11.4 ❌, 12.1 ❌, 9.6 ❌, 2.3 🔄

**Stage 2 — make failures legible.**
10.3 with `include_usage` (cost), 10.4 (timeout and abort, which unblocks
first-pass 3.9), 13 (dangling tool calls), 15.1 and 15.2 (event subscriptions),
16 (migrations).

**Status:** 10.3 ❌, 10.4 🔄, 13 ✅, 15.1 ❌, 15.2 ❌, 16 ❌

**Stage 3 — correctness over time.**
First-pass 3.5 through 3.10, 4.1 and 4.2, 10.1 and 10.2 (retry structure).

**Status:** 3.5 ✅, 3.6 ✅, 3.7 ❌, 3.8 ❌, 3.9 🔄, 3.10 ❌, 4.1 ✅, 4.2 ✅, 10.1 ✅, 10.2 ❌

**Stage 4 — consolidate.**
14.1 and 14.2 (single registries), first-pass 6.2 (CLI duplication), then the
architectural work in first-pass section 7 — with 7.1 first, since worktree
isolation dissolves most of section 9 rather than patching it.

**Status:** 14.1 🔄, 14.2 ❌, 6.2 ❌, 7.1 ❌, 7.2 ❌, 7.3 ❌, 7.4 ❌
