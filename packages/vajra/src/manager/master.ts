import type { TaskQueue, TaskState } from './taskqueue.js'
import type { ChangeHistory } from '@codekalakaars/vajra-sandbox'
import type { TaskEvent } from './ui.js'
import type { LaunchHandle } from '../developer/developer.js'
import type { ReadLockMode, ScheduleOrder, WorkerParams } from '../bench/params.js'
import { tasksConflict } from './leases.js'
import type { Governor } from './governor.js'

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

export type FailureAction = 'retry' | 'skip' | 'abort'

export interface FailureDecision {
  action: FailureAction
  reason: string
}

export interface FailureInput {
  task: TaskState
  /** Attempts already made. */
  attempts: number
  /** The task's own cap. */
  maxRetries: number
  /** The task produced no file changes — retrying cannot help. */
  noChanges: boolean
  /** The run is out of time or the user interrupted. */
  interrupted: boolean
  /** More than this many failures means the plan itself is suspect. */
  abortAfterFailures?: number
  /** Failures so far in this run. */
  failureCount?: number
}

/**
 * The mechanical decision. Deliberately free of the model: the same inputs
 * always produce the same action.
 */
export function decideFailure(input: FailureInput): FailureDecision {
  const { task, attempts, maxRetries, noChanges, interrupted } = input
  const abortAfter = input.abortAfterFailures ?? Number.POSITIVE_INFINITY
  const failureCount = input.failureCount ?? 0

  if (interrupted) {
    return { action: 'skip', reason: 'interrupted' }
  }
  // A model that changed nothing cannot do better on a second identical
  // attempt; burning the budget on it only delays the report.
  if (noChanges) {
    return { action: 'skip', reason: 'no changes were made' }
  }
  // Checked before the per-task cap: when every task is failing, the plan is
  // what is wrong, and each task exhausting its own retries first would just
  // repeat the same failure N times.
  if (failureCount >= abortAfter) {
    return { action: 'abort', reason: `${failureCount} tasks failed` }
  }
  if (attempts > maxRetries) {
    return { action: 'skip', reason: `retries exhausted (${maxRetries})` }
  }
  return { action: 'retry', reason: `attempt ${attempts} of ${maxRetries + 1}` }
}

export interface RollbackResult {
  ran: string[]
  failed: string[]
  output: string
}

/**
 * Run a task's declared rollback commands, in order, before a retry.
 *
 * Without this the `rollback` field in a plan is decorative: a task that says
 * `["git checkout src/a.ts"]` has its changes rolled back only by chance.
 */
export async function runRollbackCommands(
  commands: readonly string[],
  handle: LaunchHandle,
  timeoutMs = 60_000,
): Promise<RollbackResult> {
  const ran: string[] = []
  const failed: string[] = []
  const chunks: string[] = []

  for (const command of commands) {
    if (!command || !command.trim()) continue
    try {
      const result = await handle.callTool('run_command', { command, timeoutMs })
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      chunks.push(text)
      const exit = parseExitCode(text)
      if (exit === 0) ran.push(command)
      else failed.push(command)
    } catch (e) {
      chunks.push(`Error: ${e instanceof Error ? e.message : String(e)}`)
      failed.push(command)
    }
  }
  return { ran, failed, output: chunks.join('\n') }
}

function parseExitCode(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as { exitCode?: number }
    return typeof parsed.exitCode === 'number' ? parsed.exitCode : null
  } catch {
    return null
  }
}

/** Tasks that can never run now because a dependency ended badly. */
export function blockedDependents(queue: TaskQueue, taskId: string): string[] {
  const failed = new Set([taskId])
  const out: string[] = []
  for (const task of queue.getAllTasks()) {
    if (failed.has(task.id)) continue
    if (task.status !== 'pending') continue
    if (task.dependsOn.some(dep => failed.has(dep))) {
      failed.add(task.id)
      out.push(task.id)
    }
  }
  return out
}

/** True when a terminal failure means the *plan* is wrong, not just the task. */
export function shouldReplan(queue: TaskQueue, taskId: string): boolean {
  return blockedDependents(queue, taskId).length > 0
}

// --- choosing the next task ------------------------------------------------

/**
 * The ready tasks, in the order `scheduleOrder` asks for. The first one the
 * pool can admit is the one that starts.
 *
 * - `plan`: the order the plan lists them, which is today's behaviour.
 * - `critical-path`: the task that starts the longest chain of work still
 *   outstanding, so the chain that decides when the run ends starts first.
 * - `most-dependents`: the task holding up the most other tasks, so the run
 *   unblocks the widest set of work before it spends a Worker on a leaf.
 *
 * Ties keep plan order: the sort is stable, so an arrangement never changes
 * between two runs of the same plan on the same queue state.
 */
export function orderReadyTasks(
  queue: TaskQueue,
  order: ScheduleOrder,
  readLocks: ReadLockMode,
): TaskState[] {
  const ready = queue.getReadyTasks()
  if (order === 'plan' || ready.length < 2) return ready

  const graph = orderingGraph(queue, readLocks)
  const score = order === 'critical-path' ? heldUpLongestChain(graph) : heldUpCount(graph)
  return [...ready].sort((a, b) => score(b.id) - score(a.id))
}

/** Tasks that have not settled yet; a chain can still run through them. */
function unsettledTasks(queue: TaskQueue): TaskState[] {
  return queue
    .getAllTasks()
    .filter(task => task.status === 'pending' || task.status === 'assigned' || task.status === 'running')
}

/**
 * The edges a schedule has to respect, as `task -> tasks that cannot start
 * until it settles`: a declared dependency, or two tasks that share a file and
 * so cannot be in flight together.
 *
 * A dependency edge always points at the dependent task. A shared-file pair has
 * no declared direction, so it is chained in plan order — unless the plan
 * already puts one before the other by dependency, in which case only that
 * edge exists. That keeps the graph acyclic for a plan whose dependencies are,
 * so the scores below are a longest path rather than a walk with a cutoff.
 */
function orderingGraph(queue: TaskQueue, readLocks: ReadLockMode): Map<string, string[]> {
  const unsettled = unsettledTasks(queue)
  const byId = new Map(unsettled.map(task => [task.id, task]))
  const edges = new Map<string, string[]>(unsettled.map(task => [task.id, []]))
  const add = (from: string, to: string): void => {
    edges.get(from)?.push(to)
  }

  for (const task of unsettled) {
    for (const dep of task.dependsOn) {
      if (byId.has(dep)) add(dep, task.id)
    }
  }

  const ancestors = new Map<string, Set<string>>()
  for (const task of unsettled) {
    // Every id `dependsOn` reaches, directly or through others.
    const seen = new Set<string>()
    const stack = [...task.dependsOn]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (seen.has(id) || !byId.has(id)) continue
      seen.add(id)
      stack.push(...(byId.get(id)?.dependsOn ?? []))
    }
    ancestors.set(task.id, seen)
  }

  for (let i = 0; i < unsettled.length; i++) {
    for (let j = i + 1; j < unsettled.length; j++) {
      const earlier = unsettled[i]
      const later = unsettled[j]
      if (ancestors.get(later.id)?.has(earlier.id)) continue
      if (tasksConflict(earlier, later, readLocks)) add(earlier.id, later.id)
    }
  }

  return edges
}

/**
 * Longest chain of unsettled tasks starting at each task, itself counted: the
 * floor a schedule has to reach, so the task carrying the most of it goes first.
 */
function heldUpLongestChain(graph: Map<string, string[]>): (id: string) => number {
  const memo = new Map<string, number>()
  const walk = (id: string, visiting: Set<string>): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    // A plan whose dependencies contradict itself can still produce a loop the
    // orientation above did not remove; stop at it instead of recursing forever.
    if (visiting.has(id)) return 0
    visiting.add(id)
    let longest = 0
    for (const next of graph.get(id) ?? []) {
      longest = Math.max(longest, walk(next, visiting))
    }
    visiting.delete(id)
    const length = 1 + longest
    memo.set(id, length)
    return length
  }
  return id => walk(id, new Set())
}

/**
 * Each task's priority: how long a chain of outstanding work waits on it, so a
 * leaf nobody waits on is the lowest. Ties go to plan order — the earlier task
 * ranks higher. The scheduler pauses the lowest-priority Worker when the CPU is
 * saturated and resumes the highest first.
 */
export function taskPriorities(queue: TaskQueue, readLocks: ReadLockMode): (task: TaskState) => number {
  const chain = heldUpLongestChain(orderingGraph(queue, readLocks))
  const all = queue.getAllTasks()
  const index = new Map(all.map((task, i) => [task.id, i]))
  // The plan position is folded in below one chain step, so it only breaks ties.
  return task => chain(task.id) - (index.get(task.id) ?? all.length) / (all.length + 1)
}

/** How many unsettled tasks each task holds up, transitively. */
function heldUpCount(graph: Map<string, string[]>): (id: string) => number {
  return id => reachable(id, graph, new Set([id])).size
}

/** Every task `id` holds up, following `graph` edges once each. */
function reachable(id: string, graph: Map<string, string[]>, seen: Set<string>): Set<string> {
  for (const next of graph.get(id) ?? []) {
    if (seen.has(next)) continue
    seen.add(next)
    reachable(next, graph, seen)
  }
  return seen
}

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

// --- the LLM-driven loop (opt-in) ----------------------------------------

const MASTER_TOOL_NAMES = ['get_task_status', 'retry_task', 'amend_task', 'abort_plan'] as const

/** Tool specs for the opt-in LLM decision loop. */
export const MASTER_DECIDE_TOOL_SPECS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_task_status',
      description: 'Query the current queue status or one task in detail.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'retry_task',
      description: 'Retry a failed task from the beginning.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'amend_task',
      description: "Modify a failed task's instructions or files, then retry it.",
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          instructions: { type: 'array', items: { type: 'string' } },
          readFile: { type: 'array', items: { type: 'string' } },
          writeFile: { type: 'array', items: { type: 'string' } },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'abort_plan',
      description: 'Stop all remaining work.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
      },
    },
  },
]

export interface MasterDecideDeps {
  /** Ask the model what to do; returns the tool calls it chose. */
  ask: (systemPrompt: string, userMessage: string, signal?: AbortSignal) => Promise<
    Array<{ name: string; args: unknown }>
  >
  queue: TaskQueue
}

/**
 * The LLM decision loop from the server's master, trimmed to the tools that
 * map onto the CLI's queue. Kept behind `useLlmDecisions` — see the note at
 * the top of this file.
 */
export async function masterDecide(
  deps: MasterDecideDeps,
  failedTask: TaskState,
  context: MasterFailureContext,
  signal?: AbortSignal,
): Promise<FailureAction> {
  const status = deps.queue.getStatus()
  const systemPrompt = [
    'You are the Master agent — an orchestrator that manages task execution.',
    'A task has failed and you must decide what to do next.',
    '',
    `You have these tools: ${MASTER_TOOL_NAMES.join(', ')}.`,
    '',
    'Rules:',
    '- Call exactly one tool.',
    '- retry_task only for a task in "failed" status.',
    '- abort_plan when the failure is not fixable by retrying.',
  ].join('\n')

  const userMessage = [
    `Task "${failedTask.title}" (${failedTask.id}) has failed.`,
    `Status: ${failedTask.status}`,
    `Retries: ${context.attempts}/${context.maxRetries}`,
    context.noChanges ? 'The worker changed nothing.' : '',
    `Reason: ${context.reason}`,
    `Queue: ${status.done} done, ${status.failed} failed, ${status.pending} pending, ${status.running} running`,
    '',
    'What should be done about this failure?',
  ]
    .filter(Boolean)
    .join('\n')

  const calls = await deps.ask(systemPrompt, userMessage, signal)
  const chosen = calls[0]
  if (!chosen) return 'skip'
  if (chosen.name === 'retry_task') return 'retry'
  if (chosen.name === 'abort_plan') return 'abort'
  return 'skip'
}
