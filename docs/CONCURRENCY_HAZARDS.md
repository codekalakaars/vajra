# Concurrency hazards

What can go wrong now that tasks execute in parallel, found by reading the
implementation rather than by listing generic dangers. Every claim cites code.

Revalidated against `feat/cli-agent-v1-config` at `5fb801b` on 2026-09-26.
If a citation stops matching, the implementation has moved and this document
must be rechecked. Concurrency is live: `master.ts:231-242` admits up to
`maxWorkers` tasks and `service.ts:673-851` runs each through `runTaskOnce`.

---

## 0. What is already safe — do not "fix" these

Re-verified; spending a batch on any of these is wasted:

| Mechanism | Why it holds |
| --- | --- |
| `FileLockManager.tryAcquire` | all-or-nothing across the whole path set (`file-locks.ts:80-109`), so no hold-and-wait and **no deadlock** |
| `ChangeHistory` | every method keyed by `taskId` (`change-history.ts:53`); baselines are taken after `acquireOrWait` (`service.ts:683`, then `service.ts:758`), so a baseline is never captured mid-peer-write |
| Lock release | `finally` at `service.ts:836-839`, releasing both the lock and the sandbox task scope on every exit path |
| `TaskQueue` | `getReadyTasks` skips anything not `pending` (`taskqueue.ts:109-132`); the `running` map filters the admission race the queue cannot see (`master.ts:231-242`) |
| Per-task handle scope | `sandbox.handleForTask(task.id, …)` (`launch.ts:392`) — permissions and the dirty flag are per task, not per session |
| Provider retries | exponential backoff **with full jitter** (`chat.ts:175`), which is what stops N workers retrying in lockstep |
| Interrupt | `Promise.allSettled` on in-flight work (`master.ts:323`) before reporting |
| Output attribution | every `AgentEvent` carries an `AgentLabel` (`session/ui.ts:60-89`), and all three renderers consume it — interleaved output from concurrent workers stays attributable |

The single-threaded event loop also removes the whole class of data races on the
shared `Map`s (`taskErrors`, `taskAgents`, `noOpTasks`).

---

## Status

Six of the eight hazards are addressed; **two remain open.** Checked against the
code, not against the commit message.

| # | Hazard | State | Evidence |
| --- | --- | --- | --- |
| 1 | Concurrent shell commands contend on shared external state — **P0** | **OPEN** | nothing serialises `run_command`: `master.ts:98` and `execute.ts:390` dispatch straight through, and `execute.ts:319` runs a tool-call group under `Promise.all`, so two commands can overlap inside one task as well as across tasks |
| 2 | A worker crash fails every in-flight task at once — P0 | addressed | `launch.ts:275-296` respawns on exit, bounded by `maxSpawnRetries` |
| 3 | The parallel-safety guarantee is computed and then discarded — P0 | addressed | `writeSetOf` is exported and `planParallel` feeds real write sets into `contentionWarnings` |
| 4 | Tasks blocked on locks occupy worker slots — P1 | **OPEN** | admission happens first, then `await fileLocks.acquireOrWait(...)` at `service.ts:683` — a blocked task still holds its slot |
| 5 | The validation server has no port assignment — P1 | addressed | `allocateServerPort()` binds an ephemeral port (`tasks/server.ts:49`) |
| 6 | `persist()` re-hashes the whole plan on every transition — P1 | addressed | hashing is per changed file (`persist/session.ts:142-164`); `fileHashes` is carried, not recomputed |
| 7 | The read cache is not invalidated by `run_command` — P2 | addressed | `readCache.clear()` on command completion (`handle.ts:199,204`) |
| 8 | Git state for the staleness gate is captured mid-flight — P2 | addressed | the gate re-reads HEAD at check time rather than trusting the stored value (`session/resume.ts:93-98`) |

Hazard 1 is the one that bites hardest: a concurrent `pnpm install` corrupts
`node_modules`, and a second `git` command fails on `.git/index.lock`. Hazard 4
is a throughput problem — blocked tasks starve the pool. Both are tracked as open
work in [BACKLOG.md](BACKLOG.md).
