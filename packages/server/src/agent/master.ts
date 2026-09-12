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
import type { ManagerPlan, PlannedTask, PermissionsConfig, ToolName } from '@codekalakaars/vajra-protocol'
import { FileLockManager, type ResourceLimits } from '@codekalakaars/vajra-sandbox'
import { TaskQueue, type TaskState } from './taskqueue.js'
import { AgentRegistry, type AgentState } from './registry.js'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'
import { toOpenAiToolSpecs, roleTools } from '@codekalakaars/vajra-protocol'
import type { WorkerPool } from '../session/pool.js'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

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
  /** File lock manager for coordinating parallel access. */
  fileLocks?: FileLockManager
  /** Resource limits for workers. */
  resourceLimits?: ResourceLimits
  /** Worker pool for reuse (optional). If not provided, workers are destroyed after each task. */
  pool?: WorkerPool
}

export interface WorkerJob {
  sessionId: string
  projectDir: string
  role: 'worker'
  permissions: PermissionsConfig
  allowedTools: string[]
  taskId: string
  resourceLimits?: ResourceLimits
}

export interface MasterResult {
  summary: string
  totalTasks: number
  completedTasks: number
  failedTasks: number
  totalToolCalls: number
}

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_VALIDATION_TIMEOUT = 60000

// Worker-role tool specs for the LLM — these are the tools workers can request
const WORKER_TOOL_SPECS = toOpenAiToolSpecs(roleTools.worker as ToolName[])

/**
 * Evaluate skipIf conditions for a task.
 * Returns true if the task should be skipped.
 *
 * Supported conditions:
 * - "file exists: <path>" — skip if file exists
 * - "file missing: <path>" — skip if file does not exist
 * - "command passes: <cmd>" — skip if command exits 0 (requires handle)
 * - "command fails: <cmd>" — skip if command exits non-zero (requires handle)
 */
async function evaluateSkipIf(
  conditions: string[],
  projectDir: string,
  handle?: LaunchHandle,
): Promise<boolean> {
  for (const condition of conditions) {
    const trimmed = condition.trim()

    if (trimmed.toLowerCase().startsWith('file exists:')) {
      const filePath = trimmed.slice('file exists:'.length).trim()
      const fullPath = resolve(projectDir, filePath)
      try {
        await access(fullPath)
        continue // File exists, keep checking
      } catch {
        return true // File doesn't exist, skip
      }
    }

    if (trimmed.toLowerCase().startsWith('file missing:')) {
      const filePath = trimmed.slice('file missing:'.length).trim()
      const fullPath = resolve(projectDir, filePath)
      try {
        await access(fullPath)
        return false // File exists, don't skip
      } catch {
        continue // File doesn't exist, keep checking
      }
    }

    // Command conditions require a handle
    if (!handle) continue

    if (trimmed.toLowerCase().startsWith('command passes:')) {
      const cmd = trimmed.slice('command passes:'.length).trim()
      try {
        const result = await handle.callTool('run_command', { command: cmd, timeout: 30000 })
        const output = typeof result === 'string' ? result : JSON.stringify(result)
        if (!output.toLowerCase().includes('exit code') || output.includes('exit code 0')) {
          continue // Command passes, keep checking
        }
        return true // Command fails, skip
      } catch {
        return true // Command fails, skip
      }
    }

    if (trimmed.toLowerCase().startsWith('command fails:')) {
      const cmd = trimmed.slice('command fails:'.length).trim()
      try {
        const result = await handle.callTool('run_command', { command: cmd, timeout: 30000 })
        const output = typeof result === 'string' ? result : JSON.stringify(result)
        if (output.toLowerCase().includes('exit code') && !output.includes('exit code 0')) {
          continue // Command fails, keep checking
        }
        return false // Command passes, don't skip
      } catch {
        continue // Command fails, keep checking
      }
    }
  }

  return false // No conditions triggered skip
}

export async function masterLoop(input: MasterInput): Promise<MasterResult> {
  const { sessionId, projectDir, plan, model, apiKey, events, db, registry, launchWorker, resourceLimits, pool } = input

  // Use provided file lock manager or create a new one
  const fileLocks = input.fileLocks ?? new FileLockManager()

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

  // Process loop: assign ready tasks, wait for completions
  while (true) {
    const status = queue.getStatus()
    if (status.done + status.failed + status.skipped >= status.total) break

    // Get tasks ready to run
    const readyTasks = queue.getReadyTasks()

    // Atomically check conflicts AND acquire locks for non-conflicting tasks
    const assignable: TaskState[] = []
    for (const task of readyTasks) {
      // Try to acquire locks atomically - this prevents race conditions
      // where two tasks both pass the filter then both acquire locks
      // Use read locks for readFile, write locks for writeFile/deleteFile
      const readFiles = task.readFile
      const writeFiles = [...task.writeFile, ...task.deleteFile]
      
      // Try to acquire read locks first (shared)
      const readLocksAcquired = fileLocks.tryAcquire(readFiles, task.id, 'read')
      if (!readLocksAcquired) {
        // Cannot acquire read locks - another task has write lock on one of these files
        for (const file of readFiles) {
          const owners = fileLocks.getOwners(file)
          const otherOwner = owners.find((o) => o !== task.id)
          if (otherOwner) {
            events.push('session.conflictDetected', sessionId, {
              sessionId,
              task1: task.id,
              task2: otherOwner,
              files: [file],
            })
            break
          }
        }
        continue
      }
      
      // Try to acquire write locks (exclusive)
      const writeLocksAcquired = fileLocks.tryAcquire(writeFiles, task.id, 'write')
      if (!writeLocksAcquired) {
        // Cannot acquire write locks - release read locks and try again later
        fileLocks.releaseAll(task.id)
        for (const file of writeFiles) {
          const owners = fileLocks.getOwners(file)
          const otherOwner = owners.find((o) => o !== task.id)
          if (otherOwner) {
            events.push('session.conflictDetected', sessionId, {
              sessionId,
              task1: task.id,
              task2: otherOwner,
              files: [file],
            })
            break
          }
        }
        continue
      }
      
      // Check skipIf conditions (file-based only at this stage)
      if (task.skipIf && task.skipIf.length > 0) {
        const shouldSkip = await evaluateSkipIf(task.skipIf, projectDir)
        if (shouldSkip) {
          fileLocks.releaseAll(task.id)
          queue.skipTask(task.id)
          completedTasks.push(task.id)
          events.push('session.workerProgress', sessionId, {
            sessionId,
            agentId: masterAgent.id,
            taskId: task.id,
            detail: 'Skipped: skipIf condition met',
          })
          continue
        }
      }
      
      assignable.push(task)
    }

    // Assign ready tasks
    for (const task of assignable) {
      const agent = registry.createAgent(sessionId, 'worker', task.title, masterAgent.id)
      queue.assignTask(task.id, agent.id)
      registry.updateStatus(agent.id, 'running')

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
        executeTask(agent.id, task, handle, apiKey, model, events, db, queue, registry, sessionId, fileLocks, activeWorkers, completedTasks, failedTasks, resourceLimits, pool)
          .catch((e) => {
            console.error(`Worker ${agent.id} failed:`, e)
          })
      } catch (e) {
        // Failed to launch worker
        registry.updateStatus(agent.id, 'failed')
        queue.failTask(task.id)
        failedTasks.push(task.id)

        // Release file locks
        fileLocks.release(task.id)

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
  fileLocks: FileLockManager,
  activeWorkers: Map<string, { agent: AgentState; handle: LaunchHandle; taskId: string }>,
  completedTasks: string[],
  failedTasks: string[],
  resourceLimits?: ResourceLimits,
  pool?: WorkerPool,
): Promise<void> {
  const MAX_WORKER_TOOL_CALLS = resourceLimits?.maxToolCalls ?? 50
  let toolCallCount = 0

  try {
    // Build a prescriptive system prompt for the worker
    const instructionLines = task.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
    const readFileList = task.readFile.length > 0 ? task.readFile.join(', ') : '(none)'
    const writeFileList = task.writeFile.length > 0 ? task.writeFile.join(', ') : '(none)'
    const deleteFileList = task.deleteFile.length > 0 ? task.deleteFile.join(', ') : '(none)'
    const createDirList = task.createDir.length > 0 ? task.createDir.join(', ') : '(none)'

    const systemPrompt = [
      'You are a worker agent. Follow the instructions EXACTLY. Do not deviate.',
      '',
      `TASK: ${task.title}`,
      task.description ? `WHY: ${task.description}` : '',
      '',
      'INSTRUCTIONS (follow in order):',
      instructionLines,
      '',
      `FILES TO READ: ${readFileList}`,
      `FILES TO WRITE: ${writeFileList}`,
      `FILES TO DELETE: ${deleteFileList}`,
      `DIRS TO CREATE: ${createDirList}`,
      '',
      'RULES:',
      '- Execute each instruction step by step',
      '- Read each readFile first to understand the current code',
      '- Make precise edits using edit_file (not write_file for existing files)',
      '- Use write_file only for new files',
      '- After completing all instructions, respond with a brief summary of what was done',
    ].join('\n')

    const messages: OpenRouterMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Execute task: ${task.title}` },
    ]

    // Tool-use loop
    while (toolCallCount < MAX_WORKER_TOOL_CALLS) {
      const result = await streamChatCompletion(
        { apiKey, model, messages, tools: WORKER_TOOL_SPECS },
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
    if (task.validation.length > 0) {
      for (const cmd of task.validation) {
        events.push('session.workerProgress', sessionId, {
          sessionId,
          agentId,
          taskId: task.id,
          detail: `Running validation: ${cmd}`,
        })

        try {
          const taskTimeout = (task.timeout ?? 120) * 1000
          const validationResult = await handle.callTool('run_command', {
            command: cmd,
            timeout: taskTimeout,
          })
          const output = typeof validationResult === 'string' ? validationResult : JSON.stringify(validationResult)
          
          // Check for command failure indicators:
          // 1. Output contains "exit code" with non-zero code
          // 2. Output contains common failure patterns
          // 3. Output starts with "error" (case-insensitive)
          const hasExitCode = /exit\s+code\s+[1-9]/i.test(output)
          const hasFailPatterns = /\b(failed|failure|error|exception|panic)\b/i.test(output)
          const startsWithError = output.trimStart().toLowerCase().startsWith('error')
          
          if (hasExitCode || (hasFailPatterns && !startsWithError)) {
            validationPassed = false
            queue.recordValidation(task.id, `${cmd}\n${output}`, false)
            break
          }
          queue.recordValidation(task.id, `${cmd}\n${output}`, true)
        } catch (e) {
          validationPassed = false
          queue.recordValidation(task.id, `${cmd}\nError: ${e instanceof Error ? e.message : String(e)}`, false)
          break
        }
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
      const retries = task.retries ?? 0
      const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES

      if (retries < maxRetries) {
        queue.recordValidation(task.id, `\n[retry ${retries + 1}/${maxRetries}]`, false)
        // Reset task to pending so it gets retried on the next loop iteration
        queue.retryTask(task.id)
      } else {
        // Run rollback instructions if provided
        if (task.rollback && task.rollback.length > 0) {
          events.push('session.workerProgress', sessionId, {
            sessionId,
            agentId,
            taskId: task.id,
            detail: 'Running rollback instructions...',
          })
          for (const cmd of task.rollback) {
            try {
              await handle.callTool('run_command', { command: cmd, timeout: 30000 })
            } catch {
              // Rollback failure is non-fatal
            }
          }
        }
        
        queue.failTask(task.id)
        failedTasks.push(task.id)
        registry.updateStatus(agentId, 'failed')
        events.push('session.workerFailed', sessionId, {
          sessionId,
          agentId,
          taskId: task.id,
          error: `Validation failed after ${maxRetries} retries`,
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
    fileLocks.release(task.id)

    // Clean up worker - release back to pool for reuse, or stop if no pool
    const worker = activeWorkers.get(agentId)
    if (worker) {
      if (pool) {
        // Release back to pool for reuse
        pool.release(worker.handle)
      } else {
        // No pool - destroy the worker
        worker.handle.stop()
      }
      activeWorkers.delete(agentId)
    }
  }
}

function computeTaskPermissions(task: TaskState): PermissionsConfig {
  const files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> = {}

  // Read-only files
  for (const filePath of task.readFile) {
    files[filePath] = { read: true, write: false, edit: false, delete: false }
  }

  // Read-write files
  for (const filePath of task.writeFile) {
    files[filePath] = { read: true, write: true, edit: true, delete: false }
  }

  // Delete files
  for (const filePath of task.deleteFile) {
    files[filePath] = { read: true, write: false, edit: false, delete: true }
  }

  // Grant read to parent directories for traversal
  const allFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
  const dirs = new Set(allFiles.map((f) => {
    const parts = f.split('/')
    parts.pop()
    return parts.join('/')
  }).filter(Boolean))

  for (const dir of dirs) {
    if (!files[dir]) {
      files[dir] = { read: true, write: false, edit: false, delete: false }
    }
  }

  return {
    version: 1,
    default: { read: false, write: false, edit: false, delete: false },
    files,
  }
}

function computeToolPermissions(task: TaskState): string[] {
  // Use explicit allowedTools if provided
  if (task.toolPermissions) {
    return JSON.parse(task.toolPermissions)
  }

  // Default: read + write + edit for create/modify, read + delete for delete
  const tools = ['read_file', 'list_files', 'search_files']

  if (task.type === 'create' || task.type === 'modify' || task.type === 'refactor') {
    tools.push('write_file', 'edit_file')
  }
  if (task.type === 'delete') {
    tools.push('delete_file')
  }
  if (task.createDir.length > 0) {
    tools.push('create_dir')
  }

  return tools
}
