# Concurrency hazards

What can go wrong now that tasks execute in parallel, found by reading the
implementation rather than by listing generic dangers. Every claim cites code.

Researched against `main` at `025c93e`; every citation re-verified against
`682fc8f`, and all of them still point at the quoted code. If one stops matching,
the hazard has moved, not disappeared.
Concurrency is live: `master.ts:226-242` admits up to `maxWorkers` tasks and
`service.ts` runs each through `runTaskOnce`.

---

## 0. What is already safe — do not "fix" these

Re-verified; spending a batch on any of these is wasted:

| Mechanism | Why it holds |
| --- | --- |
| `FileLockManager.tryAcquire` | all-or-nothing across the whole path set, so no hold-and-wait and **no deadlock** |
| `ChangeHistory` | every method keyed by `taskId` (`change-history.ts:53,95,147`); baselines are taken *after* `acquireOrWait`, so a baseline is never captured mid-peer-write |
| Lock release | `finally` at `service.ts:747-752`, releasing both the lock and the sandbox task scope on every exit path |
| `TaskQueue` | `getReadyTasks` skips anything not `pending`; the `running` map filters the admission race the queue cannot see |
| Per-task handle scope | `sandbox.handleForTask(task.id, …)` — permissions and the dirty flag are per task, not per session |
| Provider retries | exponential backoff **with full jitter** (`chat.ts:175`), which is what stops N workers retrying in lockstep |
| Interrupt | `Promise.allSettled` on in-flight work (`master.ts:319`) before reporting |
| Output attribution | every `AgentEvent` carries an `AgentLabel` (`session/ui.ts:69-89`), and all three renderers consume it — interleaved output from concurrent workers stays attributable |

The single-threaded event loop also removes the whole class of data races on the
shared `Map`s (`taskErrors`, `taskAgents`, `noOpTasks`).

---

## 1. Concurrent shell commands contend on shared external state — **P0**

Nothing serialises `run_command` across tasks. Two workers can run
`npm install`, `cargo build`, or any `git` command simultaneously, against one
working tree.

- **`git`** — a second `git add`/`commit`/`checkout` fails on `.git/index.lock`.
  The plan schema encourages git in `rollback` commands, and
  `runRollbackCommands` (`service.ts:771`) can fire while a peer is mid-command.
- **`npm`/`pnpm install`** — concurrent installs into one `node_modules` is the
  documented way to corrupt it. This is real corruption, not a failed command.
- **`cargo`** — blocks on the target-directory lock, so the second task stalls
  until the first finishes, then reports a timeout as a task failure.

The damage is misattributed: the task that *lost* the race is marked failed and
rolled back, while the plan and the model look fine.

**Fix.** Give the Manager a named mutex keyed by a resource class, and derive the
class from the command: `git` → `git`, `npm|pnpm|yarn` → `node_modules`,
`cargo` → `cargo`. Tasks holding the same class serialise; everything else runs
free. `FileLockManager` already implements exactly this shape — reuse it with
synthetic paths (`"<resource:git>"`) rather than building a second mechanism.

---

## 2. A worker crash fails every in-flight task at once — **P0**

`launch.ts:242-251` registers one `exit` handler that rejects **all** pending
calls, and there is no respawn:

```ts
const onExit = (code: number | null) => {
  const err = new Error(`Sandbox worker exited (code ${code})`)
  for (const [, entry] of pending) entry.reject(err)
```

One forked worker serves every task (`worker.ts:107` builds a single handle).
Sequentially that cost one task; at `maxWorkers: 4` it costs four, all reported
as independent failures with the same opaque message, each triggering its own
rollback and retry.

An OOM from one runaway command takes the whole session with it.

**Fix.** Two options, in order of effort:

1. **Respawn and replay.** On unexpected exit, relaunch the worker, re-apply the
   sandbox, and fail only the calls that were in flight. Cheap, and turns a
   session-ending event into N task failures.
2. **Worker pool** ([BACKLOG.md](BACKLOG.md) §1). Per-task processes give real
   isolation and per-task resource limits. Previously marked "measure first" on
   throughput grounds — this is the argument that actually justifies it, and it
   is about blast radius, not speed. The `WorkerPool` source is no longer on
   `main`: read it off the `experimental-packages` branch (`bb732b2`).

---

## 3. The parallel-safety guarantee is computed and then discarded — **P0**

`plan-validate.ts` implements the write/write and read/write conflict rules, and
**both call sites throw the errors away**:

```ts
const independentGroups = planParallel(tasks).waves            // developer.ts:394
const warnings = [...planParallel(proposed.data.tasks).warnings, …]  // :1004
```

`.errors` is never read. A plan with two same-wave tasks writing one file is
accepted and scheduled.

It is worse than that, because the check cannot see most plans anyway:

```ts
export function writeSetOf(task: PlannedTaskInput): Set<string> {
  return new Set((task.edits ?? []).map((e) => e.path))   // plan-validate.ts:48
}
```

Only `edits[]`. A plan expressed with `writeFile` — the legacy shape the executor
actually consumes via `lower()` — has an **empty write set**, so `planParallel`
reports no conflicts for it under any circumstances.

**Severity, precisely:** this does not corrupt files. Runtime locks cover
`readFile + writeFile + deleteFile + createDir` (`service.ts:522`), so a genuine
overlap serialises rather than interleaves. What is lost is the *guarantee* — the
planner cannot tell you a plan is parallel-safe, and conflicts surface as
mysterious stalls (§4) instead of a plan the model is asked to fix.

**Fix.** Read `.errors` at both call sites and feed them back as a tool error,
the same way unknown `dependsOn` ids already are. Widen `writeSetOf` to
`edits[] ∪ writeFile ∪ deleteFile ∪ createDir` so it sees the plans that actually
run.

---

## 4. Tasks blocked on locks occupy worker slots — **P1**

Admission checks dependency-readiness only:

```ts
const next = queue.getReadyTasks().find(t => !running.has(t.id))   // master.ts:232
```

`acquireOrWait` then blocks *inside* `runTaskOnce`, after the task has taken a
slot. So a task waiting on a lock counts against `maxWorkers` while doing
nothing. With `maxWorkers: 4` and three tasks contending for one file, three
slots idle while ready, non-conflicting work waits behind them.

Retries make it worse: locks are held across every attempt, so one task retrying
twice holds its paths for the full duration.

No deadlock — all-or-nothing acquisition guarantees progress — but throughput can
collapse to worse than sequential, because the wasted slots also stop the
scheduler from admitting work that would have run.

**Fix.** Check `fileLocks.canAcquire(paths, 'write', task.id)` at admission and
skip to the next candidate when it would block. Re-admit on release — the lock
manager already exposes waiter notification.

---

## 5. The validation server has no port assignment — **P1**

`needsServer` (`tasks/server.ts:17`) spawns a project's entry point when
validation looks like it needs one. Nothing assigns a port. Two tasks whose
validation both match the pattern spawn two servers on the same default port;
the second dies with `EADDRINUSE`, its validation fails, and the task is rolled
back for a reason unrelated to its changes.

**Fix.** Allocate a free port per task, pass it as `PORT` in the child env, and
substitute it into validation commands — or serialise server-requiring tasks
through the §1 resource mutex.

---

## 6. `persist()` re-hashes the whole plan on every transition — **P1**

```ts
for (const path of allTaskFilePaths()) {          // service.ts:564
  const hash = hashFile(resolve(projectDir, path))
```

`allTaskFilePaths()` is the union of every path of **every task in the plan**
(`:519-525`), and `persist()` runs on every terminal transition. That is
O(tasks × files) synchronous SHA-256 on each one, on the main thread, blocking
the scheduler and every in-flight IPC reply.

Concurrency makes it worse in both directions: more transitions per unit time,
and each one now stalls three peers rather than nothing.

**Fix.** Hash only the finishing task's own paths and merge into the stored map.
Correctness is unaffected — the staleness gate compares per path.

---

## 7. The read cache is not invalidated by `run_command` — **P2**

`invalidateRead` is called from exactly four places — `write_file`, `edit_file`,
`delete_file`, `create_dir` (`handle.ts:321-351`). A file changed by
`run_command` — a build, a codegen step, `git checkout` — leaves a cache entry
behind.

Mostly benign: `readThrough` stats before every read and compares `mtimeMs`
(`:208-224`), so a changed file misses. The gap is filesystems with coarse
timestamps, where a write within the same tick can leave mtime unmoved. Under
concurrency this widens, because a peer's build can rewrite a file between
another task's stat and read.

Note also that the cache is **shared across all tasks** — one
`createToolHandle(job.projectDir)` per worker (`worker.ts:107`). That is correct
for freshness (tasks see each other's committed writes) but means tasks do not
have isolated views, which is worth knowing when reasoning about a bug.

**Fix.** Invalidate on `run_command` completion — conservatively, clear the whole
cache; precisely, clear paths under the command's `cwd`.

---

## 8. Git state for the staleness gate is captured mid-flight — **P2**

Session v2 records `git: { head, dirty }` for the resume staleness gate. Under
concurrency that snapshot is taken while peers are writing, so `dirty` reflects
an arbitrary interleaving. A resume can therefore compare against a tree state
that never existed as a coherent moment.

Low impact today — the per-file hashes are the real gate and they are taken per
path — but the git fields should be treated as advisory, and the resume prompt
should not present them as authoritative.

---

## Suggested order

1. **§1 resource mutex** — the only hazard that corrupts state outside the files
   the lock manager knows about.
2. **§2 worker respawn** — smallest change with the largest blast-radius
   reduction.
3. **§3 enforce `planParallel().errors` + widen `writeSetOf`** — makes conflicts
   a plan-time error instead of a runtime stall. Also pays back §4.
4. **§4 admission-time lock check** — the throughput fix.
5. §5, §6, then the P2 items (§7, §8).

§1–§4 together are what turn "it runs in parallel" into "it runs in parallel
safely". Until §1 lands, a plan whose tasks each run `npm install` can corrupt
`node_modules` while every task reports success.
