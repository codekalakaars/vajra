# Concurrency hazards

What can go wrong now that tasks execute in parallel, found by reading the
implementation rather than by listing generic dangers. Every claim cites code.

Revalidated against the current working tree based on `e358474` on 2026-09-25.
If a citation stops matching, the implementation has moved and this document
must be rechecked. Concurrency is live: `master.ts:231-242` admits up to
`maxWorkers` tasks and `service.ts:657-822` runs each through `runTaskOnce`.

---

## 0. What is already safe — do not "fix" these

Re-verified; spending a batch on any of these is wasted:

| Mechanism | Why it holds |
| --- | --- |
| `FileLockManager.tryAcquire` | all-or-nothing across the whole path set (`file-locks.ts:80-109`), so no hold-and-wait and **no deadlock** |
| `ChangeHistory` | every method keyed by `taskId` (`change-history.ts:53,95,147`); baselines are taken after `acquireOrWait` (`service.ts:662-667`), so a baseline is never captured mid-peer-write |
| Lock release | `finally` at `service.ts:818-822`, releasing both the lock and the sandbox task scope on every exit path |
| `TaskQueue` | `getReadyTasks` skips anything not `pending` (`taskqueue.ts:109-132`); the `running` map filters the admission race the queue cannot see (`master.ts:231-242`) |
| Per-task handle scope | `sandbox.handleForTask(task.id, …)` (`launch.ts:382-385`) — permissions and the dirty flag are per task, not per session |
| Provider retries | exponential backoff **with full jitter** (`chat.ts:175`), which is what stops N workers retrying in lockstep |
| Interrupt | `Promise.allSettled` on in-flight work (`master.ts:323`) before reporting |
| Output attribution | every `AgentEvent` carries an `AgentLabel` (`session/ui.ts:60-89`), and all three renderers consume it — interleaved output from concurrent workers stays attributable |

The single-threaded event loop also removes the whole class of data races on the
shared `Map`s (`taskErrors`, `taskAgents`, `noOpTasks`).

---

## Status

All previously listed hazards have been addressed or revalidated. The remaining
worker-pool work is tracked in [BACKLOG.md](BACKLOG.md).
