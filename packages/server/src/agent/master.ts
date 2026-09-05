// Master Agent — orchestrates task execution.
//
// The master takes the manager's plan and:
// 1. Uses the TaskQueue to determine execution order
// 2. Assigns tasks to workers (via the main process)
// 3. Monitors worker progress
// 4. Runs validation after workers complete
// 5. Handles conflicts (serializes same-file edits)
// 6. Aggregates results
//
// Like the manager, the master runs in the main server process, not in a
// sandboxed worker. It communicates with workers through the main process.

import type { SqliteDb } from '../db/client.js'
import type { PushEvents, LaunchHandle } from '../session/manager.js'
import type { ManagerPlan, PlannedTask, PermissionsConfig } from '@vajra/protocol'
import { TaskQueue, type TaskState } from './taskqueue.js'
import { AgentRegistry, type AgentState } from './registry.js'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'

export interface MasterInput {
  sessionId: string
  projectDir: string
  plan: ManagerPlan
  model: string
  apiKey: string
  events: PushEvents
  db: SqliteDb
  registry: AgentRegistry
  /** Launch a sandboxed worker for a specific task. Returns a handle for tool calls. */
  launchWorker: (job: WorkerJob) => Promise<LaunchHandle>
}

export interface WorkerJob {
  sessionId: string
  projectDir: string
  role: 'worker'
  permissions: PermissionsConfig
  allowedTools: string[]
  taskId: string
}

export interface MasterResult {
  summary: string
  totalTasks: number
  completedTasks: number
  failedTasks: number
  totalToolCalls: number
}

const MAX_RETRIES = 2
const VALIDATION_TIMEOUT = 60000

export async function masterLoop(input: MasterInput): Promise<MasterResult> {
  const { sessionId, projectDir, plan, model, apiKey, events, db, registry, launchWorker } = input

  // Create master agent
  const masterAgent = registry.createAgent(sessionId, 'master', 'Orchestrate task execution')
  registry.updateStatus(masterAgent.id, 'running')

  // Initialize task queue
  const queue = new TaskQueue(db, sessionId)
  for (const task of plan.tasks) {
    queue.addTask(task)
  }

  // Track active workers
  const activeWorkers = new Map<string, { agent: AgentState; handle: LaunchHandle; taskId: string }>()
  const completedTasks: string[] = []
  const failedTasks: string[] = []
  let totalToolCalls = 0

  // File lock map: tracks which files are currently being written
  const fileLocks = new Map<string, string>() // file -> taskId

  // Process loop: assign ready tasks, wait for completions
  while (true) {
    const status = queue.getStatus()
    if (status.done + status.failed + status.skipped >= status.total) break

    // Get tasks ready to run
    const readyTasks = queue.getReadyTasks()

    // Filter out tasks that conflict with currently running tasks
    const assignable = readyTasks.filter((task) => {
      // Check if any of this task's files are locked by another task
      for (const file of task.files) {
        const owner = fileLocks.get(file)
        if (owner && owner !== task.id) {
          events.push('session.conflictDetected', sessionId, {
            sessionId,
            task1: task.id,
            task2: owner,
            files: [file],
          })
          return false
        }
      }
      return true
    })

    // Assign ready tasks
    for (const task of assignable) {
      const agent = registry.createAgent(sessionId, 'worker', task.title, masterAgent.id)
      queue.assignTask(task.id, agent.id)
      registry.updateStatus(agent.id, 'running')

      // Lock files
      for (const file of task.files) {
        fileLocks.set(file, task.id)
      }

      // Compute scoped permissions for this worker
      const permissions = computeTaskPermissions(task)
      const toolPermissions = computeToolPermissions(task)

      // Launch the worker
      events.push('session.workerStarted', sessionId, {
        sessionId,
        agentId: agent.id,
        taskId: task.id,
      })

      try {
        const handle = await launchWorker({
          sessionId,
          projectDir,
          role: 'worker',
          permissions,
          allowedTools: toolPermissions,
          taskId: task.id,
        })

        activeWorkers.set(agent.id, { agent, handle, taskId: task.id })
        queue.startTask(task.id)

        // Start task execution in background
        executeTask(agent.id, task, handle, apiKey, model, events, db, queue, registry, sessionId, fileLocks, activeWorkers, completedTasks, failedTasks)
          .catch((e) => {
            console.error(`Worker ${agent.id} failed:`, e)
          })
      } catch (e) {
        // Failed to launch worker
        registry.updateStatus(agent.id, 'failed')
        queue.failTask(task.id)
        failedTasks.push(task.id)

        for (const file of task.files) {
          fileLocks.delete(file)
        }

        events.push('session.workerFailed', sessionId, {
          sessionId,
          agentId: agent.id,
          taskId: task.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    // Wait a bit before checking again (or for a worker to complete)
    if (activeWorkers.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    } else if (readyTasks.length === 0 && assignable.length === 0) {
      // No workers and no ready tasks — all remaining tasks are blocked
      break
    }
  }

  // Wait for any remaining workers
  while (activeWorkers.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  registry.updateStatus(masterAgent.id, 'done')

  const summary = `Completed ${completedTasks.length} of ${plan.tasks.length} tasks. Failed: ${failedTasks.length}.`

  return {
    summary,
    totalTasks: plan.tasks.length,
    completedTasks: completedTasks.length,
    failedTasks: failedTasks.length,
    totalToolCalls,
  }
}

async function executeTask(
  agentId: string,
  task: TaskState,
  handle: LaunchHandle,
  apiKey: string,
  model: string,
  events: PushEvents,
  db: SqliteDb,
  queue: TaskQueue,
  registry: AgentRegistry,
  sessionId: string,
  fileLocks: Map<string, string>,
  activeWorkers: Map<string, { agent: AgentState; handle: LaunchHandle; taskId: string }>,
  completedTasks: string[],
  failedTasks: string[],
): Promise<void> {
  const MAX_WORKER_TOOL_CALLS = 50
  let toolCallCount = 0

  try {
    // Build a mini system prompt for the worker
    const systemPrompt = [
      `You are a worker agent executing a specific task.`,
      '',
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : '',
      `Files: ${task.files.join(', ') || '(no specific files)'}`,
      '',
      'Execute the task using the available tools. When done, respond with a summary.',
    ].join('\n')

    const messages: OpenRouterMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task.title },
    ]

    // Tool-use loop
    while (toolCallCount < MAX_WORKER_TOOL_CALLS) {
      const result = await streamChatCompletion(
        { apiKey, model, messages, tools: [] }, // tools filtered at worker level
        (text) => events.push('session.assistantDelta', sessionId, { text }),
        (thinking) => events.push('session.thinkingDelta', sessionId, { text: thinking }),
      )

      if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
        // Task complete
        break
      }

      messages.push(result.message)

      for (const toolCall of result.message.tool_calls) {
        toolCallCount++
        if (toolCallCount > MAX_WORKER_TOOL_CALLS) break

        let resultContent: string
        try {
          const result = await handle.callTool(toolCall.function.name, JSON.parse(toolCall.function.arguments))
          resultContent = typeof result === 'string' ? result : JSON.stringify(result)
        } catch (e) {
          resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
        }

        messages.push({
          role: 'tool',
          content: resultContent,
          tool_call_id: toolCall.id,
        })
      }
    }

    // Task completed — run validation if specified
    let validationPassed = true
    if (task.validation) {
      events.push('session.workerProgress', sessionId, {
        sessionId,
        agentId,
        taskId: task.id,
        detail: `Running validation: ${task.validation}`,
      })

      try {
        // Validation is run through the handle (which has run_command)
        const validationResult = await handle.callTool('run_command', {
          command: task.validation,
          timeout: VALIDATION_TIMEOUT,
        })
        const output = typeof validationResult === 'string' ? validationResult : JSON.stringify(validationResult)
        validationPassed = !output.toLowerCase().includes('error') && !output.toLowerCase().includes('fail')
        queue.recordValidation(task.id, output, validationPassed)
      } catch (e) {
        validationPassed = false
        queue.recordValidation(task.id, `Validation failed: ${e instanceof Error ? e.message : String(e)}`, false)
      }
    }

    if (validationPassed) {
      queue.completeTask(task.id, true)
      completedTasks.push(task.id)
      registry.updateStatus(agentId, 'done')
      events.push('session.workerCompleted', sessionId, {
        sessionId,
        agentId,
        taskId: task.id,
        validationPassed: true,
      })
    } else {
      // Validation failed — retry if possible
      const taskState = queue.getTask(task.id)
      const retries = taskState?.validationOutput?.includes('retry') ? 0 : MAX_RETRIES

      if (retries > 0) {
        queue.recordValidation(task.id, `${taskState?.validationOutput ?? ''}\n[retrying]`, false)
        // The task will be retried on the next loop iteration
      } else {
        queue.failTask(task.id)
        failedTasks.push(task.id)
        registry.updateStatus(agentId, 'failed')
        events.push('session.workerFailed', sessionId, {
          sessionId,
          agentId,
          taskId: task.id,
          error: `Validation failed: ${taskState?.validationOutput ?? 'unknown'}`,
        })
      }
    }
  } catch (e) {
    queue.failTask(task.id)
    failedTasks.push(task.id)
    registry.updateStatus(agentId, 'failed')
    events.push('session.workerFailed', sessionId, {
      sessionId,
      agentId,
      taskId: task.id,
      error: e instanceof Error ? e.message : String(e),
    })
  } finally {
    // Release file locks
    for (const file of task.files) {
      fileLocks.delete(file)
    }

    // Clean up worker
    const worker = activeWorkers.get(agentId)
    if (worker) {
      worker.handle.stop()
      activeWorkers.delete(agentId)
    }
  }
}

function computeTaskPermissions(task: TaskState): PermissionsConfig {
  const files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> = {}

  // Grant read+write to files this task touches
  for (const filePath of task.files) {
    files[filePath] = { read: true, write: true, edit: false, delete: false }
  }

  // Grant read-only to parent directories for traversal
  const dirs = new Set(task.files.map((f) => {
    const parts = f.split('/')
    parts.pop()
    return parts.join('/')
  }).filter(Boolean))

  for (const dir of dirs) {
    files[dir] = { read: true, write: false, edit: false, delete: false }
  }

  return {
    version: 1,
    default: { read: false, write: false, edit: false, delete: false },
    files,
  }
}

function computeToolPermissions(task: TaskState): string[] {
  const tools = ['read_file', 'list_files', 'search_files']

  if (task.type === 'create' || task.type === 'modify') {
    tools.push('write_file', 'edit_file')
  }
  if (task.type === 'delete') {
    tools.push('delete_file')
  }

  return tools
}
