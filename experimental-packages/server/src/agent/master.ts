// Master Agent — orchestrates task execution.
//
// The master takes the developer's plan and:
// 1. Uses the TaskQueue to determine execution order
// 2. Assigns tasks to workers (via the main process)
// 3. Monitors worker progress
// 4. Runs validation after workers complete
// 5. Handles conflicts (serializes same-file edits)
// 6. Aggregates results
//
// Like the developer, the master runs in the main server process, not in a
// sandboxed worker. It communicates with workers through the main process.

import type { SqliteDb } from '../db/client.js'
import type { PushEvents, LaunchHandle } from '../project/manager.js'
import type { DeveloperPlan, PlannedTask, PermissionsConfig, FilePermissions } from '@codekalakaars/vajra-protocol'
import type { FileRule } from '@codekalakaars/vajra-sandbox'
import type { ChatProvider, ChatMessage } from './providers/types.js'
import { FileLockManager, ChangeHistory, type ResourceLimits } from '@codekalakaars/vajra-sandbox'
import { createWorktree, mergeWorktree, discardWorktree, getChangedFiles, cleanupWorktrees, type WorktreeInfo } from '@codekalakaars/vajra-sandbox'
import { TaskQueue, type TaskState } from './taskqueue.js'
import { AgentRegistry, type AgentState } from './registry.js'
import { getToolSpecs } from './tools.js'
import { roleTools } from '@codekalakaars/vajra-protocol'
import type { WorkerPool } from '../project/pool.js'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compressMessages } from './context.js'
import { DEFAULT_MAX_RETRIES, DEFAULT_WORKER_TOOL_CALLS, MAX_DEP_CONTEXT_SIZE } from './constants.js'
import { componentLogger } from '../logger.js'
import { stmt } from '../db/statements.js'

const log = componentLogger('master')

// --- Master agent tools ---
//
// The master gets a small LLM tool loop for high-level orchestration
// decisions: retrying, amending, splitting, or aborting tasks after
// failures. These tools are defined inline (not in the protocol package)
// because they are master-internal and never dispatched to workers.

const MAX_MASTER_LLM_TURNS = 10

const MASTER_TOOL_SPECS: import('./providers/types.js').ToolSpec[] = [
  {
    name: 'get_task_status',
    description: 'Get the status and details of a specific task, or the overall queue status.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to query. Omit for overall queue status.' },
      },
    },
  },
  {
    name: 'retry_task',
    description: 'Retry a failed task from the beginning.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to retry.' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'amend_task',
    description: 'Modify a pending or failed task\'s instructions, files, or validation before retrying.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to amend.' },
        instructions: { type: 'array', items: { type: 'string' }, description: 'New instructions (replaces existing).' },
        readFile: { type: 'array', items: { type: 'string' }, description: 'New readFile list (replaces existing).' },
        writeFile: { type: 'array', items: { type: 'string' }, description: 'New writeFile list (replaces existing).' },
        validation: { type: 'array', items: { type: 'string' }, description: 'New validation commands (replaces existing).' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'split_task',
    description: 'Split a failed task into smaller sub-tasks. The original task is replaced by the sub-tasks, which depend on the original task\'s dependencies.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to split.' },
        subTasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              instructions: { type: 'array', items: { type: 'string' } },
              readFile: { type: 'array', items: { type: 'string' } },
              writeFile: { type: 'array', items: { type: 'string' } },
              validation: { type: 'array', items: { type: 'string' } },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Indices (0-based) of sub-tasks this one depends on.' },
            },
            required: ['title', 'instructions'],
          },
          description: 'Sub-tasks to create. First sub-task inherits original dependencies.',
        },
      },
      required: ['taskId', 'subTasks'],
    },
  },
  {
    name: 'abort_plan',
    description: 'Abort the entire plan. Stops all running workers and marks remaining tasks as failed.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason for aborting.' },
      },
    },
  },
]

export interface MasterInput {
  projectId: string
  projectDir: string
  plan: DeveloperPlan
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
  /** Signal to cancel the master loop (e.g. when the project is stopped). */
  signal?: AbortSignal
  /** Whether the project allows unenforced sandbox mode. */
  allowUnenforced?: boolean
  /** Glob-based file rules from the sandbox config. */
  fileRules?: readonly FileRule[]
  /** Default file permissions for files with no matching rule. */
  defaultFilePermissions?: FilePermissions
  /** Whether to use worktree isolation for task execution. When true, each task
   *  gets its own worktree copy. On success, changes are merged back. On failure,
   *  the worktree is discarded (no complex rollback needed). Default: true. */
  useWorktrees?: boolean
}

export interface WorkerJob {
  projectId: string
  projectDir: string
  role: 'worker'
  permissions: PermissionsConfig
  allowedTools: string[]
  taskId: string
  resourceLimits?: ResourceLimits
  /** Carry the project's allowUnenforced setting to the worker. */
  allowUnenforced: boolean
  /** Glob-based file rules from the sandbox config. */
  fileRules?: readonly FileRule[]
  /** Default file permissions for files with no matching rule. */
  defaultFilePermissions?: FilePermissions
}

export interface MasterResult {
  summary: string
  totalTasks: number
  completedTasks: number
  failedTasks: number
  skippedTasks: number
  totalToolCalls: number
  totalUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

// --- Master tool execution ---

interface MasterToolContext {
  queue: TaskQueue
  registry: AgentRegistry
  taskSummaries: Map<string, string>
  completedTasks: string[]
  failedTasks: string[]
  skippedTasks: string[]
  projectId: string
}

function executeMasterTool(
  tool: import('./providers/types.js').ToolCall,
  ctx: MasterToolContext,
): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(tool.arguments)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  switch (tool.name) {
    case 'get_task_status': {
      if (args.taskId) {
        const task = ctx.queue.getTask(args.taskId as string)
        if (!task) return JSON.stringify({ error: `Task ${args.taskId} not found` })
        const summary = ctx.taskSummaries.get(task.id) ?? null
        return JSON.stringify({
          id: task.id,
          title: task.title,
          status: task.status,
          type: task.type,
          retries: task.retries,
          maxRetries: task.maxRetries,
          validationPassed: task.validationPassed,
          dependsOn: task.dependsOn,
          readFile: task.readFile,
          writeFile: task.writeFile,
          instructions: task.instructions,
          summary,
        })
      }
      return JSON.stringify(ctx.queue.getStatus())
    }
    case 'retry_task': {
      const taskId = args.taskId as string
      const task = ctx.queue.getTask(taskId)
      if (!task) return JSON.stringify({ error: `Task ${taskId} not found` })
      if (task.status !== 'failed') return JSON.stringify({ error: `Task ${taskId} is ${task.status}, not failed` })
      ctx.queue.retryTask(taskId)
      return JSON.stringify({ ok: true, message: `Task ${taskId} queued for retry` })
    }
    case 'amend_task': {
      const taskId = args.taskId as string
      const task = ctx.queue.getTask(taskId)
      if (!task) return JSON.stringify({ error: `Task ${taskId} not found` })
      if (task.status !== 'failed' && task.status !== 'pending') {
        return JSON.stringify({ error: `Task ${taskId} is ${task.status}; can only amend failed or pending tasks` })
      }
      if (args.instructions) task.instructions = args.instructions as string[]
      if (args.readFile) task.readFile = args.readFile as string[]
      if (args.writeFile) task.writeFile = args.writeFile as string[]
      if (args.validation) task.validation = args.validation as string[]
      ctx.queue.retryTask(taskId)
      return JSON.stringify({ ok: true, message: `Task ${taskId} amended and queued for retry` })
    }
    case 'split_task': {
      const taskId = args.taskId as string
      const task = ctx.queue.getTask(taskId)
      if (!task) return JSON.stringify({ error: `Task ${taskId} not found` })
      const subTasks = args.subTasks as Array<{
        title: string
        instructions: string[]
        readFile?: string[]
        writeFile?: string[]
        validation?: string[]
        dependsOn?: number[]
      }>
      if (!subTasks || subTasks.length === 0) return JSON.stringify({ error: 'No sub-tasks provided' })

      // Mark original as skipped
      ctx.queue.skipTask(taskId)

      // Create sub-tasks with proper dependencies
      const subTaskIds: string[] = []
      for (let i = 0; i < subTasks.length; i++) {
        const subId = `${taskId}-split-${i + 1}`
        subTaskIds.push(subId)
      }

      for (let i = 0; i < subTasks.length; i++) {
        const sub = subTasks[i]
        const subId = subTaskIds[i]
        // First sub-task inherits original deps; others depend on previous sub-task
        const dependsOn = i === 0
          ? [...task.dependsOn]
          : (sub.dependsOn ?? [i - 1]).map((idx) => subTaskIds[idx] ?? subTaskIds[i - 1])

        ctx.queue.addTask({
          id: subId,
          title: sub.title,
          description: '',
          instructions: sub.instructions,
          readFile: sub.readFile ?? [],
          writeFile: sub.writeFile ?? [],
          deleteFile: [],
          createDir: [],
          validation: sub.validation ?? [],
          dependsOn,
          type: task.type,
          retries: 0,
          timeout: task.timeout,
          rollback: [],
          skipIf: [],
        })
      }

      return JSON.stringify({
        ok: true,
        message: `Split task ${taskId} into ${subTasks.length} sub-tasks`,
        subTaskIds,
      })
    }
    case 'abort_plan': {
      return JSON.stringify({
        ok: true,
        message: `Plan aborted: ${args.reason ?? 'No reason given'}`,
        abort: true,
      })
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${tool.name}` })
  }
}

/**
 * Ask the LLM to decide what to do about a task failure.
 *
 * Returns the parsed tool calls from the LLM response. If the LLM returns
 * text instead of tool calls, returns an empty array (caller should skip
 * the task).
 */
async function masterDecide(
  provider: ChatProvider,
  apiKey: string,
  model: string,
  failedTask: TaskState,
  validationOutput: string | null,
  ctx: MasterToolContext,
  signal?: AbortSignal,
): Promise<import('./providers/types.js').ToolCall[]> {
  const statusSummary = ctx.queue.getStatus()
  const taskSummary = ctx.taskSummaries.get(failedTask.id) ?? '(no summary)'

  const systemPrompt = [
    'You are the Master agent — an orchestrator that manages task execution.',
    'A task has failed and you must decide what to do next.',
    '',
    'You have these tools:',
    '- get_task_status: query task or queue status',
    '- retry_task: retry a failed task from the beginning',
    '- amend_task: modify a failed task\'s instructions/files and retry',
    '- split_task: break a failed task into smaller sub-tasks',
    '- abort_plan: stop all work',
    '',
    'Rules:',
    '- You may call multiple tools in one response.',
    '- For retry_task and amend_task, the task must be in "failed" status.',
    '- For split_task, provide sub-tasks with 0-based dependsOn indices.',
    '- If you cannot fix the problem, abort the plan.',
  ].join('\n')

  const userMessage = [
    `Task "${failedTask.title}" (${failedTask.id}) has failed.`,
    '',
    `Status: ${failedTask.status}`,
    `Type: ${failedTask.type}`,
    `Retries: ${failedTask.retries}/${failedTask.maxRetries}`,
    `Files read: ${failedTask.readFile.join(', ') || '(none)'}`,
    `Files write: ${failedTask.writeFile.join(', ') || '(none)'}`,
    `Instructions: ${failedTask.instructions.join('; ')}`,
    '',
    validationOutput ? `Validation output:\n${validationOutput}` : 'No validation output (worker crashed).',
    '',
    `Queue: ${statusSummary.done} done, ${statusSummary.failed} failed, ${statusSummary.pending} pending, ${statusSummary.running} running`,
    '',
    'What should be done about this failure?',
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]

  for (let turn = 0; turn < MAX_MASTER_LLM_TURNS; turn++) {
    const result = await provider.streamChat(
      { apiKey, model, messages, tools: MASTER_TOOL_SPECS, signal },
      () => {}, // No text streaming for master decisions
    )

    if (result.message.toolCalls && result.message.toolCalls.length > 0) {
      return result.message.toolCalls
    }

    // LLM returned text instead of tool calls — ask it to use a tool
    messages.push(result.message)
    messages.push({
      role: 'user',
      content: 'Please use one of your tools to handle this failure.',
    })
  }

  return []
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
  if (conditions.length === 0) return false

  for (const condition of conditions) {
    const trimmed = condition.trim()
    const lower = trimmed.toLowerCase()

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

  return false // No condition was satisfied
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
  const { projectId, projectDir, plan, model, apiKey, provider, events, db, registry, launchWorker, resourceLimits, pool, allowUnenforced, fileRules, defaultFilePermissions } = input

  // Use provided file lock manager or create a new one
  const fileLocks = input.fileLocks ?? new FileLockManager()

  // Use provided change history or create a new one with projectDir for path resolution
  const changeHistory = input.changeHistory ?? new ChangeHistory(projectDir)

  // Worktree isolation: when enabled, each task gets its own copy of the project
  // directory. On success, changes are merged back. On failure, the worktree is
  // discarded (no complex rollback needed). This is safer than the current
  // approach where workers write directly to the live project tree.
  const useWorktrees = input.useWorktrees ?? true

  // Track worktrees for cleanup at the end
  const worktrees = new Map<string, WorktreeInfo>()

  // Accumulate token usage across all worker calls
  const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  // Use provided signal or create a new AbortController for this run
  const abortSignal = input.signal
  const ownController = input.signal ? null : new AbortController()
  const signal = abortSignal ?? ownController?.signal

  // Clean up stale data from previous runs (agents, tasks, dependencies).
  // One transaction: a failure partway through used to leave the tables
  // referring to rows that no longer existed.
  db.transaction(() => {
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
  const skippedTasks: string[] = []
  let totalToolCalls = 0

  // Adaptive concurrency based on system resources
  const adaptiveMax = pool?.stats().adaptiveMax ?? 4
  // Size against the widest execution wave, not just the first one — a plan
  // that starts with a single setup task can still fan out to six later.
  const widestWave = Math.max(1, ...plan.independentGroups.map((g) => g.length))
  const maxConcurrentWorkers = Math.min(adaptiveMax, widestWave)

  // Pre-warm: Start forking workers for independent tasks immediately.
  // Bounded by maxConcurrentWorkers (already resource-capped via adaptiveMax),
  // not a fixed constant, so machines with more CPU/mem headroom actually use it.
  const prewarmCount = maxConcurrentWorkers
  const prewarmedHandles = new Map<string, LaunchHandle>()

  if (prewarmCount > 0) {
    events.push('projects.workerProgress', projectId, {
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
          allowUnenforced: allowUnenforced ?? false,
          resourceLimits,
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
          skippedTasks.push(task.id)
          events.push('projects.workerProgress', projectId, {
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
      const agent = registry.createAgent(projectId, 'worker', task.title, masterAgent.id)
      queue.assignTask(task.id, agent.id)
      registry.updateStatus(agent.id, 'running')

      // Compute scoped permissions for this worker
      const permissions = computeTaskPermissions(task)
      const toolPermissions = computeToolPermissions(task)

      // Launch the worker
      events.push('projects.workerStarted', projectId, {
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
            agentId: agent.id,
            taskId: task.id,
            detail: 'Using pre-warmed worker',
          })
        } else {
          // Create worktree for isolated execution if enabled
          let taskProjectDir = projectDir
          let taskChangeHistory = changeHistory

          if (useWorktrees) {
            try {
              const worktree = createWorktree(projectDir, task.id)
              worktrees.set(task.id, worktree)
              taskProjectDir = worktree.worktreePath
              taskChangeHistory = new ChangeHistory(worktree.worktreePath)

              events.push('projects.workerProgress', projectId, {
                agentId: agent.id,
                taskId: task.id,
                detail: `Created worktree for isolated execution`,
              })
            } catch (e) {
              events.push('projects.workerProgress', projectId, {
                agentId: agent.id,
                taskId: task.id,
                detail: `Failed to create worktree, falling back to direct execution: ${e instanceof Error ? e.message : String(e)}`,
              })
              // Fall back to direct execution
              taskProjectDir = projectDir
              taskChangeHistory = changeHistory
            }
          }

          handle = await launchWorker({
            projectId,
            projectDir: taskProjectDir,
            role: 'worker',
            permissions,
            allowedTools: toolPermissions,
            taskId: task.id,
            allowUnenforced: allowUnenforced ?? false,
            resourceLimits,
          })
        }

        activeWorkers.set(agent.id, { agent, handle, taskId: task.id })
        queue.startTask(task.id)

        // Start task execution in background, and keep the promise so the
        // loop can await a completion instead of polling for one.
        // Use per-task change history for worktree isolation
        const taskChangeHist = worktrees.has(task.id)
          ? new ChangeHistory(worktrees.get(task.id)!.worktreePath)
          : changeHistory

        const running = executeTask(agent.id, task, handle, apiKey, model, provider, events, queue, registry, projectId, db, fileLocks, taskChangeHist, activeWorkers, completedTasks, failedTasks, taskSummaries, resourceLimits, pool, totalUsage, signal)
          .then(async (result) => {
            totalToolCalls += result.toolCalls

            // If the task already failed inside executeTask (e.g. provider error),
            // skip validation — it was already counted as failed.
            const currentTask = queue.getTask(task.id)
            if (!currentTask || currentTask.status === 'failed') return

            // Run validation in a separate worker with broader permissions
            // Use worktree path for validation if available
            let validationPassed = true
            if (task.validation.length > 0) {
              let validationHandle: LaunchHandle | null = null
              try {
                // Use worktree path for validation if available
                const validationProjectDir = worktrees.has(task.id)
                  ? worktrees.get(task.id)!.worktreePath
                  : projectDir

                validationHandle = await launchWorker({
                  projectId,
                  projectDir: validationProjectDir,
                  role: 'worker',
                  permissions: computeValidationPermissions(validationProjectDir),
                  allowedTools: ['read_file', 'list_files', 'search_files', 'run_command'],
                  taskId: `${task.id}-validation`,
                  allowUnenforced: allowUnenforced ?? false,
                  resourceLimits,
                })

                for (const cmd of task.validation) {
                  events.push('projects.workerProgress', projectId, {
                    agentId: agent.id,
                    taskId: task.id,
                    detail: `Running validation: ${cmd}`,
                  })

                  try {
                    const taskTimeout = (task.timeout ?? 120)
                    const validationResult = await validationHandle.callTool('run_command', {
                      command: cmd,
                      timeout: taskTimeout,
                    })
                    const output = typeof validationResult === 'string' ? validationResult : JSON.stringify(validationResult)

                    let exitCode = 0
                    try {
                      const parsed = JSON.parse(output)
                      exitCode = parsed.exitCode ?? 0
                    } catch {
                      exitCode = 0
                    }

                    if (exitCode !== 0) {
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
              } finally {
                if (validationHandle) {
                  validationHandle.stop()
                }
              }
            }

            if (validationPassed) {
              // Merge worktree changes back to main directory if using worktrees
              if (worktrees.has(task.id)) {
                const worktree = worktrees.get(task.id)!
                const changedFiles = getChangedFiles(worktree)
                const mergeResult = mergeWorktree(worktree, changedFiles)

                if (mergeResult.success) {
                  events.push('projects.workerProgress', projectId, {
                    agentId: agent.id,
                    taskId: task.id,
                    detail: `Merged ${mergeResult.changedFiles.length} files from worktree`,
                  })
                } else {
                  events.push('projects.workerProgress', projectId, {
                    agentId: agent.id,
                    taskId: task.id,
                    detail: `Failed to merge worktree: ${mergeResult.error}`,
                  })
                }

                // Clean up worktree
                discardWorktree(worktree)
                worktrees.delete(task.id)
              }

              queue.completeTask(task.id, true)
              completedTasks.push(task.id)
              registry.updateStatus(agent.id, 'done')
              events.push('projects.workerCompleted', projectId, {
                agentId: agent.id,
                taskId: task.id,
                validationPassed: true,
              })
            } else {
              // Validation failed — discard worktree if using worktrees
              if (worktrees.has(task.id)) {
                const worktree = worktrees.get(task.id)!
                discardWorktree(worktree)
                worktrees.delete(task.id)

                events.push('projects.workerProgress', projectId, {
                  agentId: agent.id,
                  taskId: task.id,
                  detail: 'Discarded worktree after validation failure',
                })
              }

              // Validation failed — retry if possible
              const retries = task.retries ?? 0
              const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES

              if (retries < maxRetries) {
                // No rollback needed for worktrees — worktree was already discarded
                // For non-worktree mode, rollback changes
                if (!worktrees.has(task.id) && changeHistory.hasChanges(task.id)) {
                  await changeHistory.rollback(task.id)
                  events.push('projects.workerProgress', projectId, {
                    agentId: agent.id,
                    taskId: task.id,
                    detail: `Rolled back changes before retry ${retries + 1}/${maxRetries}`,
                  })
                }

                queue.recordValidation(task.id, `\n[retry ${retries + 1}/${maxRetries}]`, false)
                queue.retryTask(task.id)
              } else {
                // Retries exhausted — roll back (non-worktree) or just fail (worktree)
                if (!worktrees.has(task.id)) {
                  events.push('projects.workerProgress', projectId, {
                    agentId: agent.id,
                    taskId: task.id,
                    detail: 'Rolling back changes...',
                  })

                  if (changeHistory.hasChanges(task.id)) {
                    const rollbackResult = await changeHistory.rollback(task.id)
                    events.push('projects.workerProgress', projectId, {
                      agentId: agent.id,
                      taskId: task.id,
                      detail: `Restored ${rollbackResult.restored.length} files, deleted ${rollbackResult.deleted.length} files`,
                    })
                  }
                }

                if (task.rollback && task.rollback.length > 0) {
                  for (const cmd of task.rollback) {
                    try {
                      await handle.callTool('run_command', { command: cmd, timeout: 30000 })
                    } catch {
                      // Rollback failure is non-fatal
                    }
                  }
                }

                // Mark as failed before LLM decision (tools require this status)
                queue.failTask(task.id)
                failedTasks.push(task.id)
                registry.updateStatus(agent.id, 'failed')

                // Retrieve validation output from DB for LLM context
                const valRow = db.prepare(
                  `SELECT validation_output FROM tasks WHERE id = ?`,
                ).get(task.id) as { validation_output?: string } | undefined

                const masterCtx: MasterToolContext = {
                  queue, registry, taskSummaries, completedTasks, failedTasks, skippedTasks, projectId,
                }

                events.push('projects.workerProgress', projectId, {
                  agentId: agent.id,
                  taskId: task.id,
                  detail: 'Asking master agent for decision...',
                })

                try {
                  const toolCalls = await masterDecide(
                    provider, apiKey, model, task, valRow?.validation_output ?? null,
                    masterCtx, signal,
                  )

                  let shouldAbort = false
                  for (const tc of toolCalls) {
                    const result = executeMasterTool(tc, masterCtx)
                    log.info({ tool: tc.name, taskId: task.id, result }, 'Master tool result')

                    events.push('projects.workerProgress', projectId, {
                      agentId: agent.id,
                      taskId: task.id,
                      detail: `Master decided: ${tc.name}`,
                    })

                    const parsed = JSON.parse(result)
                    if (parsed.abort) shouldAbort = true
                  }

                  if (shouldAbort) {
                    ownController?.abort()
                  }
                } catch (e) {
                  log.error({ error: e }, 'Master LLM decision failed')
                  events.push('projects.workerFailed', projectId, {
                    agentId: agent.id,
                    taskId: task.id,
                    error: `Validation failed after ${maxRetries} retries`,
                  })
                }
              }
            }
          })
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

    // Check if aborted
    if (signal?.aborted) break
  }

  // Wait for any remaining workers
  while (inFlight.size > 0 && !signal?.aborted) {
    await Promise.allSettled(inFlight.values())
  }

  // Cleanup any unused prewarmed handles. They were acquired from the pool,
  // so they have to go back through it — calling stop() directly leaves the
  // pool believing the slot is still checked out.
  for (const [taskId, handle] of prewarmedHandles) {
    events.push('projects.workerProgress', projectId, {
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

  // Clean up any remaining worktrees (e.g., if aborted or failed)
  for (const [taskId, worktree] of worktrees) {
    events.push('projects.workerProgress', projectId, {
      agentId: masterAgent.id,
      taskId,
      detail: 'Cleaning up worktree',
    })
    discardWorktree(worktree)
  }

  registry.updateStatus(masterAgent.id, 'done')

  const summary = `Completed ${completedTasks.length} of ${plan.tasks.length} tasks. Failed: ${failedTasks.length}. Skipped: ${skippedTasks.length}.`

  return {
    summary,
    totalTasks: plan.tasks.length,
    completedTasks: completedTasks.length,
    failedTasks: failedTasks.length,
    skippedTasks: skippedTasks.length,
    totalToolCalls,
    totalUsage: totalUsage.totalTokens > 0 ? totalUsage : undefined,
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
  queue: TaskQueue,
  registry: AgentRegistry,
  projectId: string,
  db: SqliteDb,
  fileLocks: FileLockManager,
  changeHistory: ChangeHistory,
  activeWorkers: Map<string, { agent: AgentState; handle: LaunchHandle; taskId: string }>,
  completedTasks: string[],
  failedTasks: string[],
  taskSummaries: Map<string, string>,
  resourceLimits?: ResourceLimits,
  pool?: WorkerPool,
  usageAccumulator?: { promptTokens: number; completionTokens: number; totalTokens: number },
  signal?: AbortSignal,
  launchWorker?: (job: WorkerJob) => Promise<LaunchHandle>,
): Promise<{ toolCalls: number }> {
  const MAX_WORKER_TOOL_CALLS = resourceLimits?.maxToolCalls ?? DEFAULT_WORKER_TOOL_CALLS
  let toolCallCount = 0

  try {
    // Record original file content before worker starts (parallel disk reads
    // instead of one at a time — this gates task start for every file involved)
    const allFiles = [...task.readFile, ...task.writeFile]
    await Promise.all(allFiles.map((filePath) => changeHistory.recordBefore(task.id, filePath)))

    // Build a prescriptive system prompt for the worker
    const instructionLines = task.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
    const readFileList = task.readFile.length > 0 ? task.readFile.join(', ') : '(none)'
    const writeFileList = task.writeFile.length > 0 ? task.writeFile.join(', ') : '(none)'
    const deleteFileList = task.deleteFile.length > 0 ? task.deleteFile.join(', ') : '(none)'
    const createDirList = task.createDir.length > 0 ? task.createDir.join(', ') : '(none)'

    // Gather context from completed dependencies
    const dependencyContext = gatherDependencyContext(task, queue, taskSummaries)

    const systemLines = [
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
    ]

    // On retry, include previous validation failure so worker doesn't repeat the mistake
    if ((task.retries ?? 0) > 0) {
      const retryRow = db.prepare(
        `SELECT validation_output FROM tasks WHERE id = ?`
      ).get(task.id) as { validation_output?: string } | undefined
      if (retryRow?.validation_output) {
        systemLines.push(
          '',
          `RETRY ${task.retries} — PREVIOUS VALIDATION FAILED:`,
          retryRow.validation_output,
          '',
          'Do NOT repeat the mistake above. Analyze what went wrong and fix it.',
        )
      }
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemLines.join('\n') },
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
        { apiKey, model, messages: compressedMessages, tools: workerToolSpecs, signal },
        (text) => events.push('projects.assistantDelta', projectId, { text, agentId, taskId: task.id }),
        (thinking) => events.push('projects.thinkingDelta', projectId, { text: thinking, agentId, taskId: task.id }),
      )

      // Accumulate token usage
      if (result.usage && usageAccumulator) {
        usageAccumulator.promptTokens += result.usage.promptTokens
        usageAccumulator.completionTokens += result.usage.completionTokens
        usageAccumulator.totalTokens += result.usage.totalTokens
      }

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

    // Task complete — keep the worker's own summary for its dependents.
    // Validation is handled by masterLoop after this returns.
  } catch (e) {
    queue.failTask(task.id)
    failedTasks.push(task.id)
    registry.updateStatus(agentId, 'failed')
    events.push('projects.workerFailed', projectId, {
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

  return { toolCalls: toolCallCount }
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
      // Grant write on parent dirs of writeFile entries so workers can create
      // new files in those directories (Landlock needs write on parent to create).
      const isWriteParent = task.writeFile.some(f => {
        const parent = f.split('/').slice(0, -1).join('/')
        return parent === dir || dir.startsWith(parent + '/')
      })
      const isDeleteParent = task.deleteFile.some(f => {
        const parent = f.split('/').slice(0, -1).join('/')
        return parent === dir || dir.startsWith(parent + '/')
      })
      files[dir] = {
        read: true,
        write: isWriteParent,
        edit: isWriteParent,
        delete: isDeleteParent,
      }
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
  // Always include run_command for validation commands
  const tools = ['read_file', 'list_files', 'search_files', 'run_command']

  if (task.type === 'create' || task.type === 'modify' || task.type === 'refactor') {
    tools.push('write_file', 'edit_file')
  }
  // Note: delete_file and create_dir tools are not implemented yet.
  // deleteFile/createDir fields in the plan are used for permission computation
  // only (granting write access to parent directories).

  return tools
}

/**
 * Compute permissions for a validation worker.
 * Validation needs read-write access to the entire project plus cache directories.
 */
function computeValidationPermissions(projectDir: string): PermissionsConfig {
  return {
    version: 1,
    default: { read: true, write: true, edit: true, delete: true },
    files: {
      // Grant full access to cache directories that validation commands need
      'node_modules/.cache': { read: true, write: true, edit: true, delete: true },
      '.next': { read: true, write: true, edit: true, delete: true },
      'dist': { read: true, write: true, edit: true, delete: true },
      'build': { read: true, write: true, edit: true, delete: true },
      '.turbo': { read: true, write: true, edit: true, delete: true },
      '.cache': { read: true, write: true, edit: true, delete: true },
      'tmp': { read: true, write: true, edit: true, delete: true },
      '.pytest_cache': { read: true, write: true, edit: true, delete: true },
      '__pycache__': { read: true, write: true, edit: true, delete: true },
    },
  }
}
