import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FileLockManager,
  ChangeHistory,
} from '@codekalakaars/vajra-sandbox'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import { AgentRegistry, type AgentState } from './registry.js'
import { TaskQueue, type TaskState, type TaskStatus } from './taskqueue.js'
import { streamChatCompletion, type ChatMessage, type ReasoningEffort } from '../model/chat.js'
import { evaluateSkipIfDetailed } from '../worker/skip.js'
import { taskLeases } from './leases.js'
import {
  createToolHandle,
  tokenizeCommand,
  computeTaskPermissions,
  normalizeProjectPath,
  spawnAgentPool,
  type Agent,
  type LaunchHandle,
  type ToolCache,
} from '@codekalakaars/vajra-sandbox'
import { executeTask } from '../worker/execute.js'
import { buildProjectCard } from '../worker/project-card.js'
import { buildHandoff } from './handoff.js'
import { diffsWithin, type DiffFile } from '../worker/diff.js'
import type { AttemptRecord, Handoff, WorkerContext } from '../worker/context-types.js'
import { needsServer } from '../worker/server.js'
import { masterDecide, masterLoop, runRollbackCommands, MASTER_DECIDE_TOOL_SPECS } from './master.js'
import { finalReport, type FinalReport } from './report.js'
import type { AgentEvent, AgentPhase, SessionUI } from './ui.js'
import { TODAYS_PARAMS, type WorkerParams } from '../bench/params.js'
import { Governor, type Sampler } from './governor.js'
import { PauseGate } from './pause.js'

/**
 * The cap on Workers running at once: none, unless `--concurrency` asks for one.
 *
 * Without a cap the machine decides — a task starts while CPU and RAM have room
 * for it, and the lowest-priority Worker is paused while the CPU is saturated
 * (`agent/governor.ts`). The flag stays as an explicit ceiling for a user who
 * wants one, clamped to >= 1 so a zero or negative value cannot freeze the
 * scheduler.
 */
export function resolveMaxWorkers(override?: number): number {
  if (override === undefined || !Number.isFinite(override)) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.floor(override))
}

const COMMAND_RESOURCE_PATHS: Record<string, string> = {
  git: 'resource:git',
  npm: 'resource:node_modules',
  npx: 'resource:node_modules',
  pnpm: 'resource:node_modules',
  yarn: 'resource:node_modules',
  cargo: 'resource:cargo',
}

export function commandResourcePath(command: string, argv?: readonly string[]): string | null {
  let executable: string
  if (argv?.[0]) {
    executable = argv[0]
  } else {
    const tokenized = tokenizeCommand(command)
    if (!tokenized.ok) return null
    executable = tokenized.argv[0]
  }
  const name = (executable.split(/[\\/]/).pop() ?? '').toLowerCase()
  return COMMAND_RESOURCE_PATHS[name] ?? null
}

export function withCommandResourceLock(
  handle: LaunchHandle,
  locks: FileLockManager,
  owner: string,
): LaunchHandle {
  let nextLockId = 1
  return {
    callTool: async (tool, args) => {
      if (tool !== 'run_command' || (typeof args !== 'object' || args === null)) {
        return handle.callTool(tool, args)
      }
      const command = String((args as { command?: unknown }).command ?? '')
      const argv = Array.isArray((args as { argv?: unknown }).argv)
        ? (args as { argv: unknown[] }).argv.map(String)
        : undefined
      const path = commandResourcePath(command, argv)
      if (path === null) return handle.callTool(tool, args)

      const lockOwner = `${owner}:command-resource:${nextLockId++}`
      await locks.acquireOrWait([path], lockOwner, 'write')
      try {
        return await handle.callTool(tool, args)
      } finally {
        locks.releaseFiles([path], lockOwner)
      }
    },
  }
}
/** The Master tool loop parses model output; malformed JSON is not fatal. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * `ui.onAgentEvent`, wrapped so a renderer cannot fail a run.
 *
 * The port requires `onAgentEvent`, but JavaScript test doubles and embedders may
 * not implement it. Observability must never be able to fail a run.
 */
export function safeAgentEmitter(ui: SessionUI): (event: AgentEvent) => void {
  const agentUi = ui as { onAgentEvent?: (event: AgentEvent) => void }
  return (event: AgentEvent): void => {
    try {
      agentUi.onAgentEvent?.(event)
    } catch {
      // a renderer that throws must not take the session down
    }
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
  const workerModel = params.workerModel
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

  /**
   * What each completed task published, and what each failed attempt left.
   *
   * Both are in memory and in the run's result, not in the session store: a
   * tuning run must not leave ten records per suite, and a handoff is only
   * meaningful for the run it belongs to — the files it names are changed again
   * by the next run.
   */
  const handoffs = new Map<string, Handoff>()
  const attempts = new Map<string, AttemptRecord[]>()

  /**
   * How this project is built and checked, read off its manifests once.
   *
   * Built here rather than per Worker because it is the same for all of them:
   * every pack in a run carries one card, so a Worker never spends a round
   * discovering how the tests are run.
   */
  const projectCard = buildProjectCard(projectDir)

  /**
   * The before and after of every file an attempt is on record for changing.
   *
   * Read now, because the rollback that follows a failed attempt deletes the
   * evidence: a diff captured afterwards would show nothing. `undefined` from
   * the ledger means no baseline was recorded, and there is no honest diff to
   * write for that file.
   */
  const attemptContent = (
    task: TaskState,
  ): { files: string[]; before: Map<string, string | null>; after: Map<string, string | null> } => {
    const files = changeHistory.getTaskFiles(task.id)
    const before = new Map<string, string | null>()
    const after = new Map<string, string | null>()
    for (const path of files) {
      const original = changeHistory.getOriginalContent(task.id, path)
      if (original === undefined) continue
      before.set(path, original)
      try {
        after.set(path, readFileSync(resolve(projectDir, path), 'utf-8'))
      } catch {
        after.set(path, null)
      }
    }
    return { files: [...before.keys()], before, after }
  }

  const diffOfAttempt = (task: TaskState): string => {
    const { files, before, after } = attemptContent(task)
    return diffsWithin(
      files.map((path): DiffFile => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null })),
      params.respawnDiffChars,
    )
  }

  /**
   * The handoffs a task starts from: its direct dependencies in full, and the
   * rest as interfaces only.
   *
   * Split that way because a transitive handoff describes code written against a
   * tree this task is not looking at, while the declarations it established are
   * exactly what a caller two steps away needs.
   */
  const upstreamOf = (
    task: TaskState,
  ): { direct: Handoff[]; transitive: Handoff[] } | undefined => {
    const direct: Handoff[] = []
    for (const id of task.dependsOn) {
      const handoff = handoffs.get(id)
      if (handoff) direct.push(handoff)
    }
    const transitive: Handoff[] = []
    const seen = new Set(task.dependsOn)
    const frontier = [...task.dependsOn]
    while (frontier.length > 0) {
      const id = frontier.shift() as string
      for (const depId of queue.getTask(id)?.dependsOn ?? []) {
        if (seen.has(depId)) continue
        seen.add(depId)
        const handoff = handoffs.get(depId)
        if (handoff) transitive.push(handoff)
        frontier.push(depId)
      }
    }
    return direct.length === 0 && transitive.length === 0 ? undefined : { direct, transitive }
  }

  /**
   * Acquire a task's leases, one path at a time, in path order.
   *
   * The order is the load-bearing part. Two tasks that each want two of the
   * same files can only wait on each other if they take the files in opposite
   * orders, so taking them in one global order (sorted by path) means a task
   * that is waiting holds nothing a peer is waiting for — and there is no cycle
   * to deadlock on. A blanket `acquireOrWait` over the whole set is not
   * available here: under `shared` a task's reads and its writes want different
   * modes, and grouping them by mode reintroduces exactly that cycle.
   *
   * With `exclusive` every path is a write lease, so this is the same set of
   * locks as before, taken one call at a time and in the same order every time.
   */
  const acquireLeases = async (task: TaskState): Promise<void> => {
    const leases = [...taskLeases(task, params.readLocks, projectDir)].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )
    for (const lease of leases) {
      await fileLocks.acquireOrWait([lease.path], task.id, lease.mode)
    }
  }

  /**
   * Whether every lease this task needs is free right now.
   *
   * Checked per lease for the same reason acquisition is per lease: under
   * `shared` a task may hold reads on a file a peer is reading, so one blanket
   * `write` check would refuse an admission that has no conflict in it.
   */
  const canAcquireLeases = (task: TaskState): boolean =>
    taskLeases(task, params.readLocks, projectDir).every(lease =>
      fileLocks.canAcquire([lease.path], lease.mode, task.id),
    )

  /**
   * One attempt of one task, end to end. Everything it owns (dirty flag,
   * permissions, handle scope, locks) is torn down on every exit path, and
   * a throw fails *this* task only — peers keep their changes.
   *
   * The retry policy is not here: the Manager decides whether this gets another
   * attempt. This returns whether the attempt succeeded.
   */
  const runTaskOnce = async (task: TaskState): Promise<boolean> => {
    let agent: AgentState | null = null
    let dirty = false
    try {
      const allTaskFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
      // D4: wait for locks instead of permanently skipping on conflict.
      await acquireLeases(task)

      // D2: track dirty-set via onMutate rather than changeHistory.hasChanges
      // alone (baseline records can make hasChanges unreliable across rollbacks).
      const permissions = computeTaskPermissions(task, projectDir)
      const permissionLookup = (path: string) =>
        permissions[normalizeProjectPath(projectDir, path)] ?? null

      let taskHandle: LaunchHandle
      if (sandbox) {
        taskHandle = sandbox.handleForTask(task.id, permissionLookup, () => {
          dirty = true
        })
      } else {
        taskHandle = createToolHandle(projectDir, {
          cache: toolCache,
          permissions: path => {
            const key = normalizeProjectPath(projectDir, path)
            return permissions[key] ?? { read: false, write: false, edit: false, delete: false }
          },
          onMutate: () => {
            dirty = true
          },
        })
      }
      taskHandle = withCommandResourceLock(taskHandle, commandResourceLocks, task.id)

      if (task.skipIf && task.skipIf.length > 0) {
        const skipResult = await evaluateSkipIfDetailed(
          task.skipIf,
          projectDir,
          async (command, args) => {
            const output = await taskHandle.callTool('run_command', {
              command: [command, ...args].join(' '),
              argv: [command, ...args],
              timeoutMs: 30_000,
            })
            try {
              const parsed = JSON.parse(String(output)) as { exitCode?: unknown }
              return { code: typeof parsed.exitCode === 'number' ? parsed.exitCode : -1 }
            } catch {
              return { code: -1 }
            }
          },
        )
        for (const w of skipResult.warnings) ui.warning(`⚠ ${w}`)
        const shouldSkip = skipResult.shouldSkip
        if (shouldSkip) {
          queue.skipTask(task.id)
          ui.onTaskEvent({ type: 'skipped', taskId: task.id, title: task.title })
          return true
        }
      }

      agent = registry.createAgent(sessionId, 'worker', task.title, masterAgentId)
      taskAgents.set(task.id, agent.id)
      queue.assignTask(task.id, agent.id)
      registry.updateStatus(agent.id, 'running')
      queue.startTask(task.id)

      // Progress label derived from the queue: terminal + in-flight counts
      // are still meaningful when tasks start and finish interleaved.
      const progress = queue.getStatus()
      ui.onTaskEvent({
        type: 'start',
        taskId: task.id,
        index:
          progress.done +
          progress.failed +
          progress.skipped +
          progress.assigned +
          progress.running,
        total: progress.total,
        title: task.title,
      })

      for (const filePath of allTaskFiles) {
        await changeHistory.recordBefore(task.id, filePath)
      }

      // Interrupted during setup: nothing has been written yet, so hand
      // the task back instead of reporting a run that never happened.
      if (isInterrupted()) {
        queue.returnToPending(task.id)
        if (agent) registry.updateStatus(agent.id, 'pending')
        return true
      }

      dirty = false
      const gate = new PauseGate()
      pauseGates.set(task.id, gate)
      const upstream = upstreamOf(task)
      const earlier = attempts.get(task.id) ?? []
      // What the Worker did with the attempt, once the Worker has ended it.
      let attemptEnd: Omit<AttemptRecord, 'attempt' | 'diff'> | undefined
      const workerContext: WorkerContext = {
        ...(plan.contracts && plan.contracts.length > 0 ? { contracts: plan.contracts } : {}),
        projectCard,
        ...(upstream ? { upstream } : {}),
        ...(earlier.length > 0 ? { previousAttempts: earlier } : {}),
        onAttemptEnd: record => {
          attemptEnd = record
        },
      }
      const success = await executeTask(
        agent.id,
        task,
        taskHandle,
        apiKey,
        workerModel,
        ui,
        changeHistory,
        queue,
        registry,
        sessionId,
        fileLocks,
        projectDir,
        abortSignal,
        emitWorker,
        params,
        gate,
        workerContext,
      )

      // The record of this attempt, read off disk while its changes are still
      // there. The rollback below is what makes the retry start from a clean
      // tree, and it is also what would erase this evidence.
      const recorded: AttemptRecord = {
        attempt: earlier.length + 1,
        ...(attemptEnd ?? { outcome: success ? 'done' : 'error', filesWritten: [] }),
        ...(success ? {} : { diff: diffOfAttempt(task) }),
      }
      attempts.set(task.id, [...earlier, recorded])
      if (success && attemptEnd) {
        const { before, after } = attemptContent(task)
        handoffs.set(
          task.id,
          buildHandoff({
            taskId: task.id,
            title: task.title,
            filesWritten: attemptEnd.filesWritten,
            before,
            after,
            summary: attemptEnd.summary ?? '',
            maxSummaryChars: params.handoffSummaryChars,
          }),
        )
      }

      const noChanges = !dirty && !changeHistory.hasChanges(task.id)
      if (noChanges && !success) {
        ui.onTaskEvent({ type: 'no-changes', taskId: task.id, title: task.title })
      }

      if (success) {
        queue.completeTask(task.id, true)
        registry.updateStatus(agent.id, 'done')
        ui.onTaskEvent({ type: 'done', taskId: task.id, title: task.title })
        return true
      } else {
        if (dirty || changeHistory.hasChanges(task.id)) {
          await changeHistory.rollback(task.id)
        } else {
          // Only an attempt that changed nothing is a no-op, because only that
          // is the case a second identical attempt cannot improve on. Marking
          // every failure here spent the task's retries on nothing: the Manager
          // asks `noChanges` before it looks at `maxRetries`, so a task that
          // failed having done real work was skipped as a no-op and never
          // retried, which is how a run lost a task to one stalled round.
          noOpTasks.add(task.id)
        }
        // The Manager still owns the terminal state: it may roll back and
        // try again. Hand the failure back rather than failing here.
        return false
      }
    } catch (e) {
      // A throw used to end the whole run and leak this task's locks.
      // Fail only this task, roll back only its own changes, persist.
      const message = e instanceof Error ? e.message : String(e)
      taskErrors.set(task.id, message)
      try {
        if (changeHistory.hasChanges(task.id)) {
          await changeHistory.rollback(task.id)
        }
      } catch {
        // Rollback is best effort — never let it mask the original error.
      }
      const state = queue.getTask(task.id)
      if (
        state &&
        state.status !== 'done' &&
        state.status !== 'failed' &&
        state.status !== 'skipped'
      ) {
        queue.failTask(task.id)
        ui.onTaskEvent({ type: 'failed', taskId: task.id, title: task.title })
      }
      if (agent) registry.updateStatus(agent.id, 'failed')
      ui.error(`Task failed: ${task.title} — ${message}`)
      return false
    } finally {
      // Load-bearing under concurrency: a lock leaked here deadlocks every
      // peer waiting on those paths until the process is killed.
      fileLocks.release(task.id)
      // An attempt that ends while paused (an interrupt) must not leave its gate
      // shut for the scheduler to find; release thaws the sandbox side.
      pauseGates.get(task.id)?.resume()
      pauseGates.delete(task.id)
      sandbox?.releaseTask(task.id)
    }
  }

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
      if (!canAcquireLeases(task)) return false
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
