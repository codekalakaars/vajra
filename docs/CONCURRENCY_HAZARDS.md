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

All eight hazards are addressed. Each row names the mechanism that now holds —
checked against the code, not against a commit message.

| # | Hazard | Mechanism that holds now |
| --- | --- | --- |
| 1 | Concurrent shell commands contend on shared external state — P0 | `withCommandResourceLock` (`service.ts:85`) serialises any `run_command` whose executable maps to a shared resource — git, npm, npx, pnpm, yarn, cargo (`service.ts:63`) — through a `FileLockManager`, and plan `rollback` commands go through the same path (`service.ts:857`). Commands outside that map are not serialised: see the residual note below |
| 2 | A worker crash fails every in-flight task at once — P0 | `launch.ts:275` respawns the worker on exit, bounded by `maxSpawnRetries` (`launch.ts:286`) |
| 3 | The parallel-safety guarantee is computed and then discarded — P0 | `writeSetOf` is exported (`plan-validate.ts:80`) and `planParallel` feeds real write sets into `contentionWarnings` (`plan-validate.ts:175`) |
| 4 | Tasks blocked on locks occupy worker slots — P1 | admission is gated: `canAdmitTask` (`service.ts:902`) requires `fileLocks.canAcquire(...)`, and the admission loop consults it (`master.ts:235`), so a task whose paths are locked is never admitted and never holds a slot |
| 5 | The validation server has no port assignment — P1 | `allocateServerPort()` binds an ephemeral port (`tasks/server.ts:49`), and admission reserves `<resource:validation-server>` so two tasks cannot pick the same one |
| 6 | `persist()` re-hashes the whole plan on every transition — P1 | hashing is per changed file (`persist/session.ts:142`); `fileHashes` is carried forward, not recomputed |
| 7 | The read cache is not invalidated by `run_command` — P2 | the cache generation is bumped on command completion (`handle.ts:199,204`) |
| 8 | Git state for the staleness gate is captured mid-flight — P2 | the gate re-reads HEAD at check time instead of trusting the stored value (`session/resume.ts:93`) |

**Residual on hazard 1, stated so it is not rediscovered:** serialisation is
keyed on an executable allow-list. A command that mutates shared state without
being in `COMMAND_RESOURCE_PATHS` — `python`, `make`, `docker-compose`, a bare
`node script.js` that writes into the tree — still runs unguarded. Widening the
map is cheap; a blanket per-directory lock was tried and rejected because it also
serialises read-only commands, giving up the parallelism the rest of this
scheduler works to get.
