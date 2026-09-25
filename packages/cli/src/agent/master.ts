import type { TaskQueue, TaskState } from './taskqueue.js'
import type { ChangeHistory } from '@codekalakaars/vajra-sandbox'
import type { TaskEvent } from '../session/ui.js'
import type { LaunchHandle } from './developer.js'

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

export interface MasterLoopDeps<T> {
  queue: TaskQueue
  maxWorkers: number
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
  /** Default for `decideFailure`'s `maxRetries` when a task sets none. */
  abortAfterFailures?: number
  /** The LLM decision loop, when enabled. */
  decide?: (task: TaskState, context: MasterFailureContext) => Promise<FailureAction>
  signal?: AbortSignal
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

  const outcome: MasterOutcome<TaskState> = {
    aborted: false,
    retried: [],
    skipped: [],
    blocked: [],
  }
  let failureCount = 0
  const running = new Map<string, Promise<void>>()

  const scheduleReady = (): void => {
    while (!isInterrupted() && !outcome.aborted && running.size < maxWorkers) {
      // An in-flight task is still 'pending' until it clears its own setup, so
      // the in-flight map is the real filter.
      const next = queue.getReadyTasks().find(t => !running.has(t.id))
      if (!next) return
      const tracked = runOne(next)
        .catch(() => {
          // runOne handles its own failures; this only guards the pool.
        })
        .finally(() => {
          running.delete(next.id)
        })
      running.set(next.id, tracked)
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
        title: task.title,
        attempt: attempts,
        max: maxRetries,
      })
      outcome.retried.push(task.id)
    }
  }

  while (true) {
    if (isInterrupted()) break
    const status = queue.getStatus()
    if (outcome.aborted) break
    if (status.done + status.failed + status.skipped >= status.total) break

    scheduleReady()

    // Ready work exists but nothing is running means every remaining task is
    // blocked on unresolvable dependencies — stop so the report surfaces them.
    if (running.size === 0) break

    await Promise.race([...running.values()])
  }

  // Let whatever is in flight settle; an interrupted run still owes the user
  // a truthful record of what landed.
  await Promise.allSettled([...running.values()])

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

export const MAX_MASTER_LLM_TURNS = 10

const MASTER_TOOL_NAMES = ['get_task_status', 'retry_task', 'amend_task', 'abort_plan'] as const
export type MasterToolName = (typeof MASTER_TOOL_NAMES)[number]

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
