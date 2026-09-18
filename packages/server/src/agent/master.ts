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
import type { PushEvents, LaunchHandle } from '../project/manager.js'
import type { ManagerPlan, PlannedTask, PermissionsConfig, ToolName } from '@codekalakaars/vajra-protocol'
import type { ChatProvider, ChatMessage } from './providers/types.js'
import { FileLockManager, ChangeHistory, type ResourceLimits } from '@codekalakaars/vajra-sandbox'
import { TaskQueue, type TaskState } from './taskqueue.js'
import { AgentRegistry, type AgentState } from './registry.js'
import { getToolSpecs } from './tools.js'
import { roleTools } from '@codekalakaars/vajra-protocol'
import type { WorkerPool } from '../project/pool.js'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compressMessages } from './context.js'
import { buildSummaryIndex, compressSummaryByRelevance } from './summary.js'
import { DEFAULT_MAX_RETRIES, DEFAULT_VALIDATION_TIMEOUT, SPECULATIVE_CONFIDENCE_THRESHOLD, DEFAULT_WORKER_TOOL_CALLS, MAX_DEP_CONTEXT_SIZE } from './constants.js'
import { componentLogger } from '../logger.js'
import { stmt } from '../db/statements.js'

const log = componentLogger('master')

export interface MasterInput {
  projectId: string
  projectDir: string
  plan: ManagerPlan
  model: string
  apiKey: string
  provider: ChatProvider
  events: PushEvents
  db: SqliteDb
  registry: AgentRegistry
  /** Launch a sandboxed worker for a specific task. Returns a handle for tool calls. */
  launchWorker: (job: WorkerJob) => Promise<LaunchHandle>
  /** File lock manager for coordinating parallel access. */
  fileLocks?: FileLockManager
  /** Change history for rollback support. */
  changeHistory?: ChangeHistory
  /** Resource limits for workers. */
  resourceLimits?: ResourceLimits
  /** Worker pool for reuse (optional). If not provided, workers are destroyed after each task. */
  pool?: WorkerPool
}

export interface WorkerJob {
  projectId: string
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

/**
 * Evaluate skipIf conditions for a task.
 * Returns true if the task should be skipped.
 *
 * Conditions are ORed: the first one that holds skips the task.
 *
 * Supported conditions:
 * - "file exists: <path>" — skip if file exists
 * - "file missing: <path>" — skip if file does not exist
 * - "command passes: <cmd>" — skip if command exits 0 (requires handle)
 * - "command fails: <cmd>" — skip if command exits non-zero (requires handle)
 */
export async function evaluateSkipIf(
  conditions: string[],
  projectDir: string,
  handle?: LaunchHandle,
): Promise<boolean> {
  for (const condition of conditions) {
    const trimmed = condition.trim()
    const lower = trimmed.toLowerCase()

    // Every branch below used to be inverted against its own documentation:
    // "file exists:" skipped when the file was *missing*, so tasks ran when
    // they should have been skipped and skipped when they should have run.
    if (lower.startsWith('file exists:')) {
      if (await fileExists(projectDir, trimmed.slice('file exists:'.length))) return true
      continue
    }

    if (lower.startsWith('file missing:')) {
      if (!(await fileExists(projectDir, trimmed.slice('file missing:'.length)))) return true
      continue
    }

    // Command conditions require a handle
    if (!handle) continue

    if (lower.startsWith('command passes:')) {
      if (await commandSucceeds(handle, trimmed.slice('command passes:'.length))) return true
      continue
    }

    if (lower.startsWith('command fails:')) {
      if (!(await commandSucceeds(handle, trimmed.slice('command fails:'.length)))) return true
      continue
    }
  }

  return false // No conditions triggered skip
}

async function fileExists(projectDir: string, filePath: string): Promise<boolean> {
  try {
    await access(resolve(projectDir, filePath.trim()))
    return true
  } catch {
    return false
  }
}

/**
 * Run a command in the worker and report whether it exited 0.
 *
 * The worker throws on a non-zero exit, so resolution is success and there
 * is nothing to parse out of the output.
 */
async function commandSucceeds(handle: LaunchHandle, command: string): Promise<boolean> {
  try {
    await handle.callTool('run_command', { command: command.trim(), timeout: 30000 })
    return true
  } catch {
    return false
  }
}

export async function masterLoop(input: MasterInput): Promise<MasterResult> {
  const { projectId, projectDir, plan, model, apiKey, provider, events, db, registry, launchWorker, resourceLimits, pool } = input

  // Use provided file lock manager or create a new one
  const fileLocks = input.fileLocks ?? new FileLockManager()
  
  // Use provided change history or create a new one
  const changeHistory = input.changeHistory ?? new ChangeHistory()

  // Clean up stale data from previous runs (agents, tasks, dependencies).
  // One transaction: a failure partway through used to leave the tables
  // referring to rows that no longer existed.
  db.transaction(() => {
    stmt(db, `DELETE FROM agent_messages WHERE session_id = ?`).run(projectId)
    stmt(db, `DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE session_id = ?)`).run(projectId)
    stmt(db, `DELETE FROM tasks WHERE session_id = ?`).run(projectId)
    stmt(db, `DELETE FROM agents WHERE session_id = ?`).run(projectId)
  })()

  // Create master agent
  const masterAgent = registry.createAgent(projectId, 'master', 'Orchestrate task execution')
  registry.updateStatus(masterAgent.id, 'running')

  // Initialize task queue
  const queue = new TaskQueue(db, projectId)
  for (const task of plan.tasks) {
    queue.addTask(task)
  }

  // Track active workers, and the promise each one is running under. The
  // loop used to poll this map every 100ms; awaiting the work directly costs
  // nothing while tasks run and wakes the instant one finishes.
  const activeWorkers = new Map<string, { agent: AgentState; handle: LaunchHandle; taskId: string }>()
  const inFlight = new Map<string, Promise<void>>()

  /** What each finished task reported, for injection into its dependents. */
  const taskSummaries = new Map<string, string>()
  const completedTasks: string[] = []
  const failedTasks: string[] = []
  let totalToolCalls = 0

  // Speculative execution tracking
  const speculativeTasks = new Map<string, { taskId: string; dependsOn: string[] }>()

  // Adaptive concurrency based on system resources
  const adaptiveMax = pool?.stats().adaptiveMax ?? 4
  const maxConcurrentWorkers = Math.max(1, Math.min(adaptiveMax, plan.independentGroups[0]?.length ?? 4))

  // Pre-warm: Start forking workers for independent tasks immediately
  const prewarmCount = Math.min(maxConcurrentWorkers, 4)
  const prewarmedHandles = new Map<string, LaunchHandle>()
  
  if (prewarmCount > 0) {
    events.push('projects.workerProgress', projectId, {
      projectId,
      agentId: masterAgent.id,
      taskId: 'master',
      detail: `Pre-warming ${prewarmCount} workers (max concurrent: ${maxConcurrentWorkers})...`,
    })

    const prewarmTasks = plan.tasks
      .filter(t => t.dependsOn.length === 0)
      .slice(0, prewarmCount)

    // Only the worker process is warmed here. The agent row is created when
    // the task is actually assigned — registering one now produced a second,
    // orphaned agent stuck in `pending` for the lifetime of the project.
    const prewarmPromises = prewarmTasks.map(async (task) => {
      try {
        const handle = await launchWorker({
          projectId,
          projectDir,
          role: 'worker',
          permissions: computeTaskPermissions(task),
          allowedTools: computeToolPermissions(task),
          taskId: task.id,
        })

        prewarmedHandles.set(task.id, handle)
        return { taskId: task.id, handle, success: true }
      } catch (e) {
        return { taskId: task.id, handle: null, success: false, error: e }
      }
    })

    const prewarmResults = await Promise.allSettled(prewarmPromises)
    
    // Log pre-warm results
    const prewarmSuccess = prewarmResults.filter(r => r.status === 'fulfilled' && r.value.success).length
    const prewarmFailed = prewarmResults.filter(r => r.status === 'fulfilled' && !r.value.success).length
    
    events.push('projects.workerProgress', projectId, {
      projectId,
      agentId: masterAgent.id,
      taskId: 'master',
      detail: `Pre-warmed ${prewarmSuccess} workers${prewarmFailed > 0 ? `, ${prewarmFailed} failed` : ''}`,
    })
  }

  // Process loop: assign ready tasks, wait for completions
  while (true) {
    const status = queue.getStatus()
    if (status.done + status.failed + status.skipped >= status.total) break

    // Get tasks ready to run (using smart batching for cache efficiency)
    const readyTasks = queue.getReadyTasks()

    // Atomically check conflicts AND acquire locks for non-conflicting tasks
    const assignable: TaskState[] = []
    for (const task of readyTasks) {
      // Respect the concurrency limit, which was computed and then ignored —
      // every assignable task was launched at once no matter how many
      // workers were already running. Checked before the locks are taken so
      // a task we are not going to start does not hold them.
      if (inFlight.size + assignable.length >= maxConcurrentWorkers) break

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
            events.push('projects.conflictDetected', projectId, {
              projectId,
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
            events.push('projects.conflictDetected', projectId, {
              projectId,
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
          events.push('projects.workerProgress', projectId, {
            projectId,
            agentId: masterAgent.id,
            taskId: task.id,
            detail: 'Skipped: skipIf condition met',
          })
          continue
        }
      }
      
      assignable.push(task)
    }

    // Speculative execution: start tasks with high-confidence dependencies
    if (assignable.length === 0 && inFlight.size < maxConcurrentWorkers) {
      const pendingTasks = queue.getReadyTasks().filter(t => 
        t.dependsOn.length > 0 && 
        !speculativeTasks.has(t.id) &&
        t.dependsOn.some(depId => {
          const dep = queue.getTask(depId)
          return dep?.status === 'running' || dep?.status === 'assigned'
        })
      )

      for (const task of pendingTasks) {
        // Calculate confidence based on dependency status
        const deps = task.dependsOn.map(depId => queue.getTask(depId)).filter(Boolean)
        const runningDeps = deps.filter(d => d?.status === 'running' || d?.status === 'assigned')
        const completedDeps = deps.filter(d => d?.status === 'done')
        
        // Confidence: completed deps are 100%, running deps are ~80% likely to succeed
        const confidence = (completedDeps.length * 1.0 + runningDeps.length * 0.8) / deps.length

        if (confidence >= SPECULATIVE_CONFIDENCE_THRESHOLD) {
          events.push('projects.workerProgress', projectId, {
            projectId,
            agentId: masterAgent.id,
            taskId: task.id,
            detail: `Speculative execution: confidence ${(confidence * 100).toFixed(0)}%`,
          })
          
          // Mark as speculative
          speculativeTasks.set(task.id, {
            taskId: task.id,
            dependsOn: task.dependsOn,
          })
          
          // Add to assignable (will be processed in the assignment loop)
          assignable.push(task)
        }
      }
    }

    // Assign ready tasks
    for (const task of assignable) {
      const agent = registry.createAgent(projectId, 'worker', task.title, masterAgent.id)
      queue.assignTask(task.id, agent.id)
      registry.updateStatus(agent.id, 'running')

      // Compute scoped permissions for this worker
      const permissions = computeTaskPermissions(task)
      const toolPermissions = computeToolPermissions(task)

      // Launch the worker
      events.push('projects.workerStarted', projectId, {
        projectId,
        agentId: agent.id,
        taskId: task.id,
      })

      try {
        // Use prewarmed handle if available, otherwise launch new worker
        let handle: LaunchHandle
        const prewarmedHandle = prewarmedHandles.get(task.id)
        if (prewarmedHandle) {
          handle = prewarmedHandle
          prewarmedHandles.delete(task.id)
          events.push('projects.workerProgress', projectId, {
            projectId,
            agentId: agent.id,
            taskId: task.id,
            detail: 'Using pre-warmed worker',
          })
        } else {
          handle = await launchWorker({
            projectId,
            projectDir,
            role: 'worker',
            permissions,
            allowedTools: toolPermissions,
            taskId: task.id,
          })
        }

        activeWorkers.set(agent.id, { agent, handle, taskId: task.id })
        queue.startTask(task.id)

        // Start task execution in background, and keep the promise so the
        // loop can await a completion instead of polling for one.
        const running = executeTask(agent.id, task, handle, apiKey, model, provider, events, db, queue, registry, projectId, fileLocks, changeHistory, activeWorkers, completedTasks, failedTasks, taskSummaries, resourceLimits, pool)
          .catch((e) => {
            log.error({ agentId: agent.id, error: e }, 'Worker failed')
          })
          .finally(() => {
            inFlight.delete(agent.id)
          })
        inFlight.set(agent.id, running)
      } catch (e) {
        // Failed to launch worker
        registry.updateStatus(agent.id, 'failed')
        queue.failTask(task.id)
        failedTasks.push(task.id)

        // Release file locks
        fileLocks.release(task.id)

        events.push('projects.workerFailed', projectId, {
          projectId,
          agentId: agent.id,
          taskId: task.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    if (inFlight.size > 0) {
      // Wake as soon as any worker finishes: it may unblock a dependency or
      // free a file lock.
      await Promise.race(inFlight.values())
    } else if (assignable.length === 0) {
      // Nothing running and nothing startable — the rest is blocked.
      break
    }
  }

  // Wait for any remaining workers
  while (inFlight.size > 0) {
    await Promise.allSettled(inFlight.values())
  }

  // Handle speculative task rollbacks if any dependencies failed
  for (const [specTaskId, specInfo] of speculativeTasks) {
    const specTask = queue.getTask(specTaskId)
    if (!specTask || specTask.status === 'done' || specTask.status === 'failed') continue

    // Check if any dependency failed
    const depFailed = specInfo.dependsOn.some(depId => {
      const dep = queue.getTask(depId)
      return dep?.status === 'failed'
    })

    if (depFailed) {
      events.push('projects.workerProgress', projectId, {
        projectId,
        agentId: masterAgent.id,
        taskId: specTaskId,
        detail: 'Rolling back speculative execution: dependency failed',
      })

      // Rollback changes using change history
      if (changeHistory.hasChanges(specTaskId)) {
        const result = await changeHistory.rollback(specTaskId)
        events.push('projects.workerProgress', projectId, {
          projectId,
          agentId: masterAgent.id,
          taskId: specTaskId,
          detail: `Restored ${result.restored.length} files, deleted ${result.deleted.length} files`,
        })
      }

      // Mark as failed
      queue.failTask(specTaskId)
      failedTasks.push(specTaskId)

      // Stop the worker if it's still running
      for (const [agentId, worker] of activeWorkers) {
        if (worker.taskId === specTaskId) {
          worker.handle.stop()
          activeWorkers.delete(agentId)
          registry.updateStatus(agentId, 'failed')
          break
        }
      }
    }
  }

  // Cleanup any unused prewarmed handles. They were acquired from the pool,
  // so they have to go back through it — calling stop() directly leaves the
  // pool believing the slot is still checked out.
  for (const [taskId, handle] of prewarmedHandles) {
    events.push('projects.workerProgress', projectId, {
      projectId,
      agentId: masterAgent.id,
      taskId,
      detail: 'Discarding unused pre-warmed worker',
    })
    if (pool) {
      pool.release(handle, false)
    } else {
      handle.stop()
    }
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

/**
 * Gather context from completed dependency tasks.
 * Returns a formatted string with what each dependency produced.
 */
function gatherDependencyContext(
  task: TaskState,
  queue: TaskQueue,
  taskSummaries: Map<string, string>,
): string {
  if (task.dependsOn.length === 0) return ''

  const contextParts: string[] = []
  let totalSize = 0

  for (const depId of task.dependsOn) {
    if (totalSize >= MAX_DEP_CONTEXT_SIZE) break

    const depTask = queue.getTask(depId)
    if (!depTask) continue

    // Workers report their summary directly. This used to hunt for it with
    // `content LIKE '%<task id>%'` over the whole messages table: an
    // unindexed scan per dependency per task, which also matched any message
    // that merely mentioned the id.
    const summary = taskSummaries.get(depId) ?? ''

    const filesModified = [...depTask.writeFile, ...depTask.deleteFile]
    const depContext = [
      `Task ${depId}: ${depTask.title}`,
      `Status: ${depTask.status}`,
      filesModified.length > 0 ? `Files modified: ${filesModified.join(', ')}` : '',
      summary ? `Summary: ${summary.slice(0, 500)}` : '',
    ].filter(Boolean).join('\n')

    if (depContext) {
      contextParts.push(depContext)
      totalSize += depContext.length
    }
  }

  return contextParts.length > 0
    ? `TASKS THIS DEPENDS ON (completed):\n${contextParts.join('\n\n')}`
    : ''
}

async function executeTask(
  agentId: string,
  task: TaskState,
  handle: LaunchHandle,
  apiKey: string,
  model: string,
  provider: ChatProvider,
  events: PushEvents,
  db: SqliteDb,
  queue: TaskQueue,
  registry: AgentRegistry,
  projectId: string,
  fileLocks: FileLockManager,
  changeHistory: ChangeHistory,
  activeWorkers: Map<string, { agent: AgentState; handle: LaunchHandle; taskId: string }>,
  completedTasks: string[],
  failedTasks: string[],
  taskSummaries: Map<string, string>,
  resourceLimits?: ResourceLimits,
  pool?: WorkerPool,
): Promise<void> {
  const MAX_WORKER_TOOL_CALLS = resourceLimits?.maxToolCalls ?? DEFAULT_WORKER_TOOL_CALLS
  let toolCallCount = 0

  try {
    // Record original file content before worker starts
    const allFiles = [...task.readFile, ...task.writeFile]
    for (const filePath of allFiles) {
      await changeHistory.recordBefore(task.id, filePath)
    }
    
    // Build a prescriptive system prompt for the worker
    const instructionLines = task.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
    const readFileList = task.readFile.length > 0 ? task.readFile.join(', ') : '(none)'
    const writeFileList = task.writeFile.length > 0 ? task.writeFile.join(', ') : '(none)'
    const deleteFileList = task.deleteFile.length > 0 ? task.deleteFile.join(', ') : '(none)'
    const createDirList = task.createDir.length > 0 ? task.createDir.join(', ') : '(none)'

    // Gather context from completed dependencies
    const dependencyContext = gatherDependencyContext(task, queue, taskSummaries)

    const systemPrompt = [
      'You are a worker agent. Follow the instructions EXACTLY. Do not deviate.',
      '',
      `TASK: ${task.title}`,
      task.description ? `WHY: ${task.description}` : '',
      '',
      dependencyContext ? `DEPENDENCY CONTEXT:\n${dependencyContext}\n` : '',
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

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Execute task: ${task.title}` },
    ]

    const providerType = provider.name === 'anthropic' ? 'anthropic' : 'openai'
    const workerToolSpecs = getToolSpecs(providerType).filter((t) =>
      (roleTools.worker as string[]).includes(t.name)
    )

    // Tool-use loop
    while (toolCallCount < MAX_WORKER_TOOL_CALLS) {
      // Compress for the request only. The full history stays in `messages`:
      // overwriting it with the compressed view discards context permanently
      // and makes every later turn compress an already-lossy transcript.
      const compressedMessages = compressMessages(messages, model)

      const result = await provider.streamChat(
        { apiKey, model, messages: compressedMessages, tools: workerToolSpecs },
        (text) => events.push('projects.assistantDelta', projectId, { text }),
        (thinking) => events.push('projects.thinkingDelta', projectId, { text: thinking }),
      )

      if (!result.message.toolCalls || result.message.toolCalls.length === 0) {
        // Task complete — keep the worker's own summary for its dependents.
        if (result.message.content) taskSummaries.set(task.id, result.message.content)
        break
      }

      messages.push(result.message)

      for (const toolCall of result.message.toolCalls) {
        toolCallCount++
        // Over budget: answer the call with an error instead of breaking out
        // of the batch. Every tool call in the assistant message needs a
        // result — leaving one unanswered makes the next request invalid.
        const overBudget = toolCallCount > MAX_WORKER_TOOL_CALLS

        let resultContent: string
        if (overBudget) {
          resultContent = `Error: tool call budget exhausted (${MAX_WORKER_TOOL_CALLS}). Stop calling tools and summarize what was done.`
        } else {
          try {
            const result = await handle.callTool(toolCall.name, JSON.parse(toolCall.arguments))
            resultContent = typeof result === 'string' ? result : JSON.stringify(result)
          } catch (e) {
            resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        }

        messages.push({
          role: 'tool',
          content: resultContent,
          toolCallId: toolCall.id,
        })
      }
    }

    // Task completed — run validation if specified
    let validationPassed = true
    if (task.validation.length > 0) {
      for (const cmd of task.validation) {
        events.push('projects.workerProgress', projectId, {
          projectId,
          agentId,
          taskId: task.id,
          detail: `Running validation: ${cmd}`,
        })

        // The exit code is the verdict. Scanning output for words like
        // "error" failed any suite that printed "0 errors" or named a test
        // after a failure case, and the worker already throws on a non-zero
        // exit, so there is nothing to scan for.
        try {
          const taskTimeout = (task.timeout ?? 120) * 1000
          const validationResult = await handle.callTool('run_command', {
            command: cmd,
            timeout: taskTimeout,
          })
          const output = typeof validationResult === 'string' ? validationResult : JSON.stringify(validationResult)
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
      events.push('projects.workerCompleted', projectId, {
        projectId,
        agentId,
        taskId: task.id,
        validationPassed: true,
      })
    } else {
      // Validation failed — retry if possible
      const retries = task.retries ?? 0
      const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES

      if (retries < maxRetries) {
        // Rollback changes before retry
        if (changeHistory.hasChanges(task.id)) {
          await changeHistory.rollback(task.id)
          events.push('projects.workerProgress', projectId, {
            projectId,
            agentId,
            taskId: task.id,
            detail: `Rolled back changes before retry ${retries + 1}/${maxRetries}`,
          })
        }
        
        queue.recordValidation(task.id, `\n[retry ${retries + 1}/${maxRetries}]`, false)
        // Reset task to pending so it gets retried on the next loop iteration
        queue.retryTask(task.id)
      } else {
        // Rollback using change history (preferred) or manual rollback commands
        events.push('projects.workerProgress', projectId, {
          projectId,
          agentId,
          taskId: task.id,
          detail: 'Rolling back changes...',
        })
        
        // Try change history rollback first
        if (changeHistory.hasChanges(task.id)) {
          const result = await changeHistory.rollback(task.id)
          events.push('projects.workerProgress', projectId, {
            projectId,
            agentId,
            taskId: task.id,
            detail: `Restored ${result.restored.length} files, deleted ${result.deleted.length} files`,
          })
        }
        
        // Also run manual rollback commands if provided (for external changes)
        if (task.rollback && task.rollback.length > 0) {
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
        events.push('projects.workerFailed', projectId, {
          projectId,
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
    events.push('projects.workerFailed', projectId, {
      projectId,
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

// Helper to compute permissions from either PlannedTask or TaskState
function computeTaskPermissions(task: PlannedTask | TaskState): PermissionsConfig {
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

// Helper to compute tool permissions from either PlannedTask or TaskState
function computeToolPermissions(task: PlannedTask | TaskState): string[] {
  // Use explicit allowedTools if provided (PlannedTask has this directly)
  if ('allowedTools' in task && task.allowedTools) {
    return task.allowedTools
  }
  
  // Use toolPermissions if provided (TaskState has this as JSON string)
  if ('toolPermissions' in task && task.toolPermissions) {
    try {
      return JSON.parse(task.toolPermissions)
    } catch {
      // Corrupted JSON, fall through to defaults
    }
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
