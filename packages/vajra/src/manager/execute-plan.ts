import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ChangeHistory,
  createToolHandle,
  FileLockManager,
  type Agent,
  type ToolCache,
} from '@codekalakaars/vajra-sandbox'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import { streamChatCompletion, type ChatMessage, type ReasoningEffort } from '../model/chat.js'
import { buildProjectCard } from '../worker/project-card.js'
import { needsServer } from '../worker/server.js'
import type { WorkerParams } from '../bench/params.js'
import { createAttemptLog } from './attempts.js'
import { commandResourcePath, withCommandResourceLock } from './command-locks.js'
import { Governor, resolveMaxWorkers, type Sampler } from './governor.js'
import { canAcquireTaskLeases } from './leases.js'
import { masterDecide, masterLoop, runRollbackCommands, MASTER_DECIDE_TOOL_SPECS } from './master.js'
import { PauseGate } from './pause.js'
import { AgentRegistry } from './registry.js'
import { finalReport, type FinalReport } from './report.js'
import { createTaskRunner } from './run-task.js'
import { TaskQueue, type TaskState, type TaskStatus } from './taskqueue.js'
import { safeAgentEmitter, type AgentEvent, type AgentPhase, type SessionUI } from './ui.js'

/** The Master tool loop parses model output; malformed JSON is not fatal. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * What a plan execution borrows from the session that proposed it.
 *
 * `runSession` supplies all of it. A bench run supplies almost none — no
 * Developer, no prompts, no persisted conversation — and that is the point: a
 * predefined plan reaches the scheduler through the same code path a session
 * uses, rather than a second implementation of it.
 */
export interface ExecutePlanDeps {
  /**
   * The Worker pool. Absent or `null` runs tools in-process: no OS sandbox and
   * no forked workers, which is what a bench run wants — the arrangement being
   * measured is the scheduler's, not the host's.
   */
  sandbox?: Agent | null
  /** The session this run belongs to; a fresh id when absent. */
  sessionId?: string
  /** Agents the session already created, so the record is one timeline. */
  registry?: AgentRegistry
  masterAgentId?: string
  toolCache?: ToolCache
  changeHistory?: ChangeHistory
  fileLocks?: FileLockManager
  commandResourceLocks?: FileLockManager
  /** Reads CPU and RAM for the governor. Injected by the tests; the machine's own by default. */
  sampler?: Sampler
  /** The Manager asking the model what to do about a failure (ADR-0010). */
  managerDecision?: {
    model: string
    asks: boolean
    reasoningEffort: ReasoningEffort
  }
}

/** What a run of a plan is given by whoever started it. */
export interface ExecutePlanOptions {
  apiKey: string
  projectDir: string
  /** Default per-task timeout in seconds, for tasks whose plan names none. */
  timeout?: number
  /** An optional cap on Workers at once. Absent: no cap; CPU and RAM decide. */
  concurrency?: number
  /** Aborting finishes the current step and ends the run. */
  signal?: AbortSignal
}

/** What one plan execution left behind. */
export interface ExecutePlanResult {
  /** The report's code: 0 when every task completed. */
  exitCode: number
  report: FinalReport
  /** The Manager stopped the plan rather than letting it drain. */
  aborted: boolean
  abortedReason?: string
  /** Workers the run was allowed at once, as params resolved it. */
  maxWorkers: number
  /** One row per task: how it ended, and why if it did not. */
  tasks: Array<{ id: string; title: string; status: TaskStatus; error?: string }>
  /** First Worker spawned to last task completed; 0 when none ever started. */
  wallMs: number
}


export async function executePlan(
  plan: DeveloperPlan,
  params: WorkerParams,
  options: ExecutePlanOptions,
  ui: SessionUI,
  deps: ExecutePlanDeps = {},
): Promise<ExecutePlanResult> {
  if (!options.apiKey) {
    throw new Error(`No API key for worker model '${params.workerModel}'`)
  }
  // Narrowed here so the per-task closure below sees a definite string.
  const apiKey = options.apiKey
  const projectDir = resolve(options.projectDir)
  if (!existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`)
  }

  const sandbox = deps.sandbox ?? null
  const sessionId = deps.sessionId ?? randomUUID()
  const registry = deps.registry ?? new AgentRegistry()
  const masterAgentId =
    deps.masterAgentId ?? registry.createAgent(sessionId, 'master', 'Orchestrate task execution').id
  const toolCache = deps.toolCache ?? { read: new Map(), generation: 0 }
  const changeHistory = deps.changeHistory ?? new ChangeHistory(projectDir)
  const fileLocks = deps.fileLocks ?? new FileLockManager()
  const commandResourceLocks = deps.commandResourceLocks ?? new FileLockManager()
  const manager = deps.managerDecision
  const abortSignal = options.signal ?? new AbortController().signal
  const isInterrupted = () => abortSignal.aborted
  const emitAgent = safeAgentEmitter(ui)

  // No Worker count: CPU and RAM decide, unless a session passed --concurrency.
  const maxWorkers = resolveMaxWorkers(options.concurrency)
  const governor = new Governor(params, deps.sampler)

  /**
   * Each running task's pause switch. The governor's decision reaches a Worker
   * in two halves: the gate stops its model loop here, and the sandbox freezes
   * the commands it is running.
   */
  const pauseGates = new Map<string, PauseGate>()
  /** Each Worker's last phase, so a resumed Worker shows what it was doing. */
  const workerPhases = new Map<string, AgentPhase>()
  const emitWorker = (event: AgentEvent): void => {
    if (event.type === 'phase' && event.agent.role === 'worker' && event.agent.taskId && event.phase !== 'paused') {
      workerPhases.set(event.agent.taskId, event.phase)
    }
    emitAgent(event)
  }
  const workerLabel = (task: TaskState) => ({ role: 'worker' as const, taskId: task.id, title: task.title })

  // D3: queue default timeout comes from the CLI -t flag (seconds).
  const queue = new TaskQueue(sessionId, options.timeout ?? 300)
  for (const task of plan.tasks) {
    const state = queue.addTask(task)
    // `retries` is the run's policy for every task. A plan's own value is
    // ignored: a sweep varies the arrangement, and a plan that quietly asked
    // for a different number of attempts would make two candidates incomparable.
    state.maxRetries = params.retries
  }

  ui.info(
    Number.isFinite(maxWorkers)
      ? `Concurrency: at most ${maxWorkers} task${maxWorkers === 1 ? '' : 's'} at a time`
      : 'Concurrency: no cap; Workers start while CPU and RAM have room',
  )

  const taskErrors = new Map<string, string>()
  /** Tasks whose last attempt changed nothing — a retry cannot help. */
  const noOpTasks = new Set<string>()
  /** The worker agent each task is running under, for terminal transitions. */
  const taskAgents = new Map<string, string>()

  const projectCard = buildProjectCard(projectDir)
  const attemptLog = createAttemptLog({
    queue,
    changeHistory,
    projectDir,
    respawnDiffChars: params.respawnDiffChars,
    handoffSummaryChars: params.handoffSummaryChars,
  })
  const runTaskOnce = createTaskRunner({
    plan, params, projectDir, apiKey, abortSignal, ui, queue, registry, sessionId, masterAgentId,
    sandbox, toolCache, changeHistory, fileLocks, commandResourceLocks, emitWorker, attemptLog,
    projectCard, pauseGates, taskErrors, noOpTasks, taskAgents,
  })

  /**
   * §4: the Manager owns the scheduler and the failure policy; this
   * callback just says how a single attempt is run.
   */
  const masterResult = await masterLoop({
    queue,
    maxWorkers,
    params,
    resources: {
      governor,
      pauseTask: task => {
        const gate = pauseGates.get(task.id)
        if (!gate || gate.paused) return false
        gate.pause()
        sandbox?.pauseTask(task.id)
        emitAgent({ type: 'phase', agent: workerLabel(task), phase: 'paused' })
        return true
      },
      resumeTask: task => {
        const gate = pauseGates.get(task.id)
        if (!gate?.paused) return
        sandbox?.resumeTask(task.id)
        gate.resume()
        emitAgent({ type: 'phase', agent: workerLabel(task), phase: workerPhases.get(task.id) ?? 'executing' })
      },
    },
    isInterrupted,
    defaultMaxRetries: params.retries,
    runTask: runTaskOnce,
    taskWasNoOp: id => noOpTasks.has(id),
    rollbackTask: async task => {
      // Honour the plan's own rollback commands first — without this the
      // `rollback` field in a plan is decorative.
      if (task.rollback && task.rollback.length > 0) {
        const handle = withCommandResourceLock(
          sandbox?.handle ?? createToolHandle(projectDir, { cache: toolCache }),
          commandResourceLocks,
          task.id,
        )
        const result = await runRollbackCommands(task.rollback, handle)
        if (result.failed.length > 0) {
          ui.warning(`Rollback command failed for ${task.title}: ${result.failed[0]}`)
        }
      }
      if (changeHistory.hasChanges(task.id)) {
        await changeHistory.rollback(task.id)
      }
    },
    failTask: async (task, reason) => {
      if (changeHistory.hasChanges(task.id)) {
        await changeHistory.rollback(task.id)
      }
      const state = queue.getTask(task.id)
      if (state && state.status !== 'done' && state.status !== 'skipped') {
        queue.failTask(task.id)
        ui.onTaskEvent({ type: 'failed', taskId: task.id, title: task.title })
      }
      const agentId = taskAgents.get(task.id)
      if (agentId) registry.updateStatus(agentId, 'failed')
      // The Manager's reason is a fallback: a real error from the attempt
      // is more useful to whoever reads the record.
      if (!taskErrors.has(task.id)) taskErrors.set(task.id, reason)
    },
    parkTask: async task => {
      queue.returnToPending(task.id)
      const agentId = taskAgents.get(task.id)
      if (agentId) registry.updateStatus(agentId, 'pending')
    },
    rebaselineTask: async task => {
      // Re-baseline so the next attempt starts from the restored files.
      for (const filePath of [...task.readFile, ...task.writeFile, ...task.deleteFile]) {
        await changeHistory.recordBefore(task.id, filePath)
      }
    },
    onTaskEvent: event => ui.onTaskEvent(event),
    canAdmitTask: task => {
      if (!canAcquireTaskLeases(fileLocks, task, params.readLocks, projectDir)) return false
      const resourcePaths = [
        ...task.rollback,
        ...task.validation,
        ...task.skipIf
          .filter(condition => /^command passes:/i.test(condition.trim()))
          .map(condition => condition.trim().replace(/^command passes:/i, '').trim()),
      ]
        .map(command => commandResourcePath(command))
        .filter((path): path is string => path !== null)
      const serverPath = needsServer(task.validation) ? '<resource:validation-server>' : null
      return commandResourceLocks.canAcquire(resourcePaths, 'write', task.id) &&
        (serverPath === null || fileLocks.canAcquire([serverPath], 'write', task.id))
    },
    ...(manager?.asks
      ? {
          decide: (task, context) =>
            masterDecide(
              {
                queue,
                ask: async (systemPrompt, userMessage) => {
                  const messages: ChatMessage[] = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                  ]
                  const decided = await streamChatCompletion(
                    {
                      apiKey,
                      model: manager.model,
                      reasoningEffort: manager.reasoningEffort,
                      messages,
                      tools: MASTER_DECIDE_TOOL_SPECS,
                      ...(abortSignal ? { signal: abortSignal } : {}),
                    },
                    () => {},
                  )
                  return (decided.message.tool_calls ?? []).map(call => ({
                    name: call.function.name,
                    args: safeJson(call.function.arguments),
                  }))
                },
              },
              task,
              context,
              abortSignal,
            ),
        }
      : {}),
  })

  // Final flush so the record reflects exactly what is on disk now.

  const finalStatus = queue.getStatus()
  ui.newline()
  ui.info('📊 Results:')
  const report = finalReport(finalStatus)
  for (const line of report.lines) {
    if (report.exitCode === 0) ui.success(line)
    else ui.warning(line)
  }
  ui.newline()
  if (report.exitCode === 0) {
    ui.success('✅ Done!')
  } else {
    ui.error('Completed with failures or pending tasks.')
  }

  // The score of a bench run: first Worker spawned to last task completed. A
  // plan whose every task was already done never spawned one, and is 0ms.
  const started = queue
    .getAllTasks()
    .map(task => task.startedAt)
    .filter((at): at is number => at !== null)
  const ended = queue
    .getAllTasks()
    .map(task => task.completedAt)
    .filter((at): at is number => at !== null)
  const wallMs = started.length > 0 && ended.length > 0
    ? Math.max(...ended) - Math.min(...started)
    : 0

  return {
    exitCode: report.exitCode,
    report,
    aborted: masterResult.aborted,
    ...(masterResult.abortedReason !== undefined
      ? { abortedReason: masterResult.abortedReason }
      : {}),
    maxWorkers,
    tasks: queue.getAllTasks().map(task => {
      const error = taskErrors.get(task.id)
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        ...(error !== undefined ? { error } : {}),
      }
    }),
    wallMs,
  }
}
