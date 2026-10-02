import type { TaskQueue, TaskState } from './taskqueue.js'
import { FailureAction } from './failure-policy.js'
import { MasterFailureContext } from './master.js'

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
