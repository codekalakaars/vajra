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
import type { ChatProvider, ChatMessage } from './providers/types.js'
import { FileLockManager, ChangeHistory, type ResourceLimits } from '@codekalakaars/vajra-sandbox'
import { TaskQueue, type TaskState } from './taskqueue.js'
import { AgentRegistry, type AgentState } from './registry.js'
import { getToolSpecs } from './tools.js'
import { roleTools } from '@codekalakaars/vajra-protocol'
import type { WorkerPool } from '../session/pool.js'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compressMessages } from './context.js'
import { buildSummaryIndex, compressSummaryByRelevance } from './summary.js'

export interface MasterInput {
  sessionId: string
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
  const { sessionId, projectDir, plan, model, apiKey, provider, events, db, registry, launchWorker, resourceLimits, pool } = input

  // Use provided file lock manager or create a new one
  const fileLocks = input.fileLocks ?? new FileLockManager()
  
  // Use provided change history or create a new one
  const changeHistory = input.changeHistory ?? new ChangeHistory()

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

  // Speculative execution tracking
  const speculativeTasks = new Map<string, { taskId: string; dependsOn: string[] }>()
  const SPECULATIVE_CONFIDENCE_THRESHOLD = 0.8

  // Pre-warm: Start forking workers for independent tasks immediately
  const prewarmCount = Math.min(plan.independentGroups[0]?.length ?? 0, 4)
  const prewarmedHandles = new Map<string, LaunchHandle>()
  
  if (prewarmCount > 0) {
    events.push('session.workerProgress', sessionId, {
      sessionId,
      agentId: masterAgent.id,
      taskId: 'master',
      detail: `Pre-warming ${prewarmCount} workers...`,
    })

    const prewarmTasks = plan.tasks
      .filter(t => t.dependsOn.length === 0)
      .slice(0, prewarmCount)

    const prewarmPromises = prewarmTasks.map(async (task) => {
      try {
        const agent = registry.createAgent(sessionId, 'worker', task.title, masterAgent.id)
        const permissions = computeTaskPermissions(task)
        const toolPermissions = computeToolPermissions(task)

        const handle = await launchWorker({
          sessionId,
          projectDir,
          role: 'worker',
          permissions,
          allowedTools: toolPermissions,
          taskId: task.id,
        })

        prewarmedHandles.set(task.id, handle)
        return { taskId: task.id, agent, handle, success: true }
      } catch (e) {
        return { taskId: task.id, agent: null, handle: null, success: false, error: e }
      }
    })

    const prewarmResults = await Promise.allSettled(prewarmPromises)
    
    // Log pre-warm results
    const prewarmSuccess = prewarmResults.filter(r => r.status === 'fulfilled' && r.value.success).length
    const prewarmFailed = prewarmResults.filter(r => r.status === 'fulfilled' && !r.value.success).length
    
    events.push('session.workerProgress', sessionId, {
      sessionId,
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

    // Speculative execution: start tasks with high-confidence dependencies
    if (assignable.length === 0 && activeWorkers.size < (pool?.stats().adaptiveMax ?? 4)) {
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
          events.push('session.workerProgress', sessionId, {
            sessionId,
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
        // Use prewarmed handle if available, otherwise launch new worker
        let handle: LaunchHandle
        const prewarmedHandle = prewarmedHandles.get(task.id)
        if (prewarmedHandle) {
          handle = prewarmedHandle
          prewarmedHandles.delete(task.id)
          events.push('session.workerProgress', sessionId, {
            sessionId,
            agentId: agent.id,
            taskId: task.id,
            detail: 'Using pre-warmed worker',
          })
        } else {
          handle = await launchWorker({
            sessionId,
            projectDir,
            role: 'worker',
            permissions,
            allowedTools: toolPermissions,
            taskId: task.id,
          })
        }

        activeWorkers.set(agent.id, { agent, handle, taskId: task.id })
        queue.startTask(task.id)

        // Start task execution in background
        executeTask(agent.id, task, handle, apiKey, model, provider, events, db, queue, registry, sessionId, fileLocks, changeHistory, activeWorkers, completedTasks, failedTasks, resourceLimits, pool)
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
      events.push('session.workerProgress', sessionId, {
        sessionId,
        agentId: masterAgent.id,
        taskId: specTaskId,
        detail: 'Rolling back speculative execution: dependency failed',
      })

      // Rollback changes using change history
      if (changeHistory.hasChanges(specTaskId)) {
        const result = await changeHistory.rollback(specTaskId)
        events.push('session.workerProgress', sessionId, {
          sessionId,
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

  // Cleanup any unused prewarmed handles
  for (const [taskId, handle] of prewarmedHandles) {
    events.push('session.workerProgress', sessionId, {
      sessionId,
      agentId: masterAgent.id,
      taskId,
      detail: 'Discarding unused pre-warmed worker',
    })
    handle.stop()
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
function gatherDependencyContext(task: TaskState, queue: TaskQueue, db: SqliteDb): string {
  if (task.dependsOn.length === 0) return ''

  const contextParts: string[] = []
  let totalSize = 0
  const MAX_CONTEXT_SIZE = 4000 // Limit total dependency context

  for (const depId of task.dependsOn) {
    if (totalSize >= MAX_CONTEXT_SIZE) break

    const depTask = queue.getTask(depId)
    if (!depTask) continue

    // Get the completion summary from the database
    const row = db.prepare(
      `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content LIKE ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(task.sessionId, `%${depId}%`) as { content: string } | undefined

    let summary = ''
    if (row?.content) {
      try {
        const parsed = JSON.parse(row.content)
        if (parsed.summary) {
          summary = parsed.summary
        }
      } catch {
        // Not JSON, use raw content
        summary = row.content.slice(0, 500)
      }
    }

    // Build context for this dependency
    const filesModified = [...depTask.writeFile, ...depTask.deleteFile]
    const depContext = [
      `Task ${depId}: ${depTask.title}`,
      `Status: ${depTask.status}`,
      filesModified.length > 0 ? `Files modified: ${filesModified.join(', ')}` : '',
      summary ? `Summary: ${summary}` : '',
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
  sessionId: string,
  fileLocks: FileLockManager,
  changeHistory: ChangeHistory,
  activeWorkers: Map<string, { agent: AgentState; handle: LaunchHandle; taskId: string }>,
  completedTasks: string[],
  failedTasks: string[],
  resourceLimits?: ResourceLimits,
  pool?: WorkerPool,
): Promise<void> {
  const MAX_WORKER_TOOL_CALLS = resourceLimits?.maxToolCalls ?? 50
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
    const dependencyContext = gatherDependencyContext(task, queue, db)

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
      // Compress messages to fit within context window
      const compressedMessages = compressMessages(messages, model)

      const result = await provider.streamChat(
        { apiKey, model, messages: compressedMessages, tools: workerToolSpecs },
        (text) => events.push('session.assistantDelta', sessionId, { text }),
        (thinking) => events.push('session.thinkingDelta', sessionId, { text: thinking }),
      )

      if (!result.message.toolCalls || result.message.toolCalls.length === 0) {
        // Task complete
        break
      }

      messages.push(result.message)

      for (const toolCall of result.message.toolCalls) {
        toolCallCount++
        if (toolCallCount > MAX_WORKER_TOOL_CALLS) break

        let resultContent: string
        try {
          const result = await handle.callTool(toolCall.name, JSON.parse(toolCall.arguments))
          resultContent = typeof result === 'string' ? result : JSON.stringify(result)
        } catch (e) {
          resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
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
        // Rollback changes before retry
        if (changeHistory.hasChanges(task.id)) {
          await changeHistory.rollback(task.id)
          events.push('session.workerProgress', sessionId, {
            sessionId,
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
        events.push('session.workerProgress', sessionId, {
          sessionId,
          agentId,
          taskId: task.id,
          detail: 'Rolling back changes...',
        })
        
        // Try change history rollback first
        if (changeHistory.hasChanges(task.id)) {
          const result = await changeHistory.rollback(task.id)
          events.push('session.workerProgress', sessionId, {
            sessionId,
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
