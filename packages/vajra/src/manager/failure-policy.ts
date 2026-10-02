import type { TaskQueue, TaskState } from './taskqueue.js'
import type { LaunchHandle } from '../developer/developer.js'

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
