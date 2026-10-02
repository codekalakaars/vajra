import type { TaskQueue, TaskState } from './taskqueue.js'
import type { TaskEvent } from './ui.js'
import type { WorkerParams } from '../bench/params.js'
import type { Governor } from './governor.js'
import { FailureAction, FailureDecision, blockedDependents, decideFailure } from './failure-policy.js'
import { orderReadyTasks, taskPriorities } from './ordering.js'

// The Manager's public surface: the entry point is this file, whichever file defines a name.
export * from './failure-policy.js'
export * from './ordering.js'
export * from './master-llm.js'

/**
 * The Manager.
 *
 * `runSession` used to *contain* the scheduler; it now calls `masterLoop`.
 * The Manager owns three things the session had no single home for:
 *
 *  - **scheduling** — which ready tasks may start, and when a free slot opens;
 *  - **failure policy** — retry, skip, or re-plan, decided mechanically;
 *  - **rollback** — the `rollback` commands a task declares, honoured in order.
 *
 * The LLM-driven decision loop from the server's master is available behind
 * `useLlmDecisions`. It is off by default: the mechanical decisions are the
 * ones that must be predictable, and a model in this loop makes failures
 * non-deterministic in the worst place to have that.
 */

/**
 * How the scheduler reaches the machine: the governor that reads CPU and RAM,
 * and the two halves of pausing a Worker, which only the host can do.
 */
export interface MasterResources {
  governor: Governor
  /** Pause a running task's Worker. False when it has nothing to pause yet. */
  pauseTask: (task: TaskState) => boolean
  resumeTask: (task: TaskState) => void
}

export interface MasterLoopDeps<T> {
  queue: TaskQueue
  /** A hard ceiling on Workers at once; `Infinity` leaves it to `resources`. */
  maxWorkers: number
  /** Admission and pausing by CPU and RAM. Absent: only `maxWorkers` bounds the run. */
  resources?: MasterResources
  isInterrupted: () => boolean
  /** Run one task end to end. Resolves true on success. */
  runTask: (task: TaskState) => Promise<boolean>
  /** True when the task produced no changes (retrying cannot help). */
  taskWasNoOp: (taskId: string) => boolean
  /** Run the task's declared rollback commands, if any. */
  rollbackTask: (task: TaskState) => Promise<void>
  /**
   * Mark a task terminally failed: roll back its changes, record why, and let
   * the report see it. The Manager owns this because it is the thing that
   * decided there will be no further attempt.
   */
  failTask: (task: TaskState, reason: string) => Promise<void> | void
  /**
   * Hand a task back to the queue because the run was interrupted. It is not a
   * failure — the record must show "never finished", not "failed" and not a
   * task stranded mid-flight.
   */
  parkTask: (task: TaskState, reason: string) => Promise<void> | void
  /** Re-base a task after a rollback, so the next attempt starts clean. */
  rebaselineTask: (task: TaskState) => Promise<void>
  /** Stop scheduling: the plan is not salvageable. */
  onTaskEvent: (event: TaskEvent) => void
  /** Defaults to `task.maxRetries ?? 2`. */
  defaultMaxRetries?: number
  /** Admission-time resource check; false means the task must wait. */
  canAdmitTask?: (task: TaskState) => boolean
  /** Default for `decideFailure`'s `maxRetries` when a task sets none. */
  abortAfterFailures?: number
  /** The LLM decision loop, when enabled. */
  decide?: (task: TaskState, context: MasterFailureContext) => Promise<FailureAction>
  signal?: AbortSignal
  /** The run's arrangement. The scheduler reads `scheduleOrder` and `readLocks` from it. */
  params: WorkerParams
}

export interface MasterFailureContext {
  reason: string
  noChanges: boolean
  attempts: number
  maxRetries: number
}

export interface MasterOutcome<T> {
  /** True when the Manager stopped the plan rather than letting it drain. */
  aborted: boolean
  abortedReason?: string
  /** Tasks the Manager re-ran, in order. */
  retried: string[]
  /** Tasks that ended up skipped without completing. */
  skipped: string[]
  /** Tasks whose dependencies died, so they can never run. */
  blocked: string[]
}

const DEFAULT_MAX_RETRIES = 2

/**
 * Bounded-concurrency scheduler with the failure policy applied.
 *
 * Tops the pool up the moment any task settles — no wave barrier — and stops
 * scheduling the moment the run is interrupted or aborted.
 */
export async function masterLoop(deps: MasterLoopDeps<TaskState>): Promise<MasterOutcome<TaskState>> {
  const {
    queue,
    maxWorkers,
    isInterrupted,
    runTask,
    taskWasNoOp,
    rollbackTask,
    failTask,
    parkTask,
    rebaselineTask,
    onTaskEvent,
    decide,
    abortAfterFailures,
  } = deps
  const { scheduleOrder, readLocks } = deps.params

  const outcome: MasterOutcome<TaskState> = {
    aborted: false,
    retried: [],
    skipped: [],
    blocked: [],
  }
  let failureCount = 0
  const running = new Map<string, Promise<void>>()
  const runningTasks = new Map<string, TaskState>()
  /** Tasks whose Worker the scheduler paused, by id. */
  const paused = new Set<string>()
  const resources = deps.resources

  /**
   * Whether the machine has room for one more Worker. The first task always
   * starts — a machine busy with something else must slow the run, not stall it
   * — and nothing new starts while a paused Worker is waiting to resume.
   */
  const machineHasRoom = (): boolean => {
    if (!resources || running.size === 0) return true
    return paused.size === 0 && resources.governor.canAdmit()
  }

  /**
   * One step per reading: pause one Worker while the CPU is saturated, resume
   * one once it has room again. One at a time, so each step's effect shows up
   * in the next reading before another is taken. The last unpaused Worker is
   * never paused, so the run always moves.
   */
  const onSample = (): void => {
    if (!resources || isInterrupted() || outcome.aborted) return
    const { governor } = resources
    if (governor.choking()) {
      const active = [...runningTasks.values()].filter(task => !paused.has(task.id))
      if (active.length <= 1) return
      const priority = taskPriorities(queue, readLocks)
      for (const task of active.sort((a, b) => priority(a) - priority(b))) {
        if (resources.pauseTask(task)) {
          paused.add(task.id)
          return
        }
      }
    } else if (governor.relieved() && paused.size > 0) {
      const priority = taskPriorities(queue, readLocks)
      const next = [...paused]
        .map(id => runningTasks.get(id))
        .filter((task): task is TaskState => task !== undefined)
        .sort((a, b) => priority(b) - priority(a))[0]
      if (!next) return
      paused.delete(next.id)
      resources.resumeTask(next)
    }
  }

  const resumeAll = (): void => {
    if (!resources) return
    for (const id of paused) {
      const task = runningTasks.get(id)
      if (task) resources.resumeTask(task)
    }
    paused.clear()
  }

  const scheduleReady = (): void => {
    while (!isInterrupted() && !outcome.aborted && running.size < maxWorkers && machineHasRoom()) {
      // Reordered per the run's arrangement, and rebuilt on every pass: what is
      // ready and what is admissible both change as slots free up.
      const ready = orderReadyTasks(queue, scheduleOrder, readLocks)
      // An in-flight task is still 'pending' until it clears its own setup, so
      // the in-flight map is the real filter.
      const next = ready.find(t => !running.has(t.id) && (deps.canAdmitTask?.(t) ?? true))
      if (!next) return
      resources?.governor.noteAdmitted()
      const tracked = runOne(next)
        .catch(() => {
          // runOne handles its own failures; this only guards the pool.
        })
        .finally(() => {
          running.delete(next.id)
          runningTasks.delete(next.id)
          paused.delete(next.id)
        })
      running.set(next.id, tracked)
      runningTasks.set(next.id, next)
    }
  }

  const runOne = async (task: TaskState): Promise<void> => {
    const maxRetries = task.maxRetries ?? deps.defaultMaxRetries ?? DEFAULT_MAX_RETRIES
    let attempts = task.retries ?? 0

    for (;;) {
      if (isInterrupted() || outcome.aborted) return
      const success = await runTask(task)
      // Counted *after* the attempt, so `attempts` is attempts made — the
      // thing the cap is expressed in.
      attempts++
      if (success) return
      // Counted before the decision so `abortAfterFailures: 1` means "abort on
      // the first failure", not "abort after one more".
      failureCount++

      const noChanges = taskWasNoOp(task.id)
      const context: MasterFailureContext = { reason: '', noChanges, attempts, maxRetries }

      let decision: FailureDecision = decideFailure({
        task,
        attempts,
        maxRetries,
        noChanges,
        interrupted: isInterrupted(),
        ...(abortAfterFailures === undefined ? {} : { abortAfterFailures }),
        failureCount,
      })
      if (decide) {
        context.reason = decision.reason
        const action = await decide(task, context)
        decision = { action, reason: `master decided: ${action}` }
      }

      if (decision.action !== 'retry') {
        if (decision.action === 'abort' && !outcome.aborted) {
          outcome.aborted = true
          outcome.abortedReason = decision.reason
        }
        // An interrupt is not a failure: the task goes back in the queue so the
        // record shows "never finished" rather than a task stranded mid-flight.
        if (decision.reason === 'interrupted') await parkTask(task, decision.reason)
        else await failTask(task, decision.reason)
        return
      }

      await rollbackTask(task)
      await rebaselineTask(task)
      onTaskEvent({
        type: 'retry',
        taskId: task.id,
        title: task.title,
        attempt: attempts,
        max: maxRetries,
      })
      outcome.retried.push(task.id)
    }
  }

  resources?.governor.start(onSample)

  while (true) {
    if (isInterrupted()) break
    const status = queue.getStatus()
    if (outcome.aborted) break
    if (status.done + status.failed + status.skipped >= status.total) break

    scheduleReady()

    // Ready work exists but nothing is running means every remaining task is
    // blocked on unresolvable dependencies — stop so the report surfaces them.
    if (running.size === 0) break

    // A reading can make room as surely as a task finishing can, so the loop
    // wakes on either.
    await Promise.race([
      ...running.values(),
      ...(resources ? [resources.governor.nextSample()] : []),
    ])
  }

  // A paused Worker cannot notice the run ending, so every one is resumed
  // before waiting on them; an interrupted run still owes the user a truthful
  // record of what landed.
  resumeAll()
  await Promise.allSettled([...running.values()])
  resources?.governor.stop()

  for (const task of queue.getAllTasks()) {
    if (task.status === 'skipped') outcome.skipped.push(task.id)
  }
  for (const task of queue.getAllTasks()) {
    if (task.status === 'pending' || task.status === 'failed') {
      outcome.blocked.push(...blockedDependents(queue, task.id))
    }
  }
  outcome.blocked = [...new Set(outcome.blocked)]

  return outcome
}
