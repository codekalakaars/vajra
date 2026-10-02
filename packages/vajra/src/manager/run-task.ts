import {
  computeTaskPermissions,
  createToolHandle,
  normalizeProjectPath,
  type Agent,
  type ChangeHistory,
  type FileLockManager,
  type LaunchHandle,
  type ToolCache,
} from '@codekalakaars/vajra-sandbox'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import type { WorkerParams } from '../bench/params.js'
import type { AttemptRecord, WorkerContext } from '../worker/context-types.js'
import { executeTask } from '../worker/execute.js'
import { evaluateSkipIfDetailed } from '../worker/skip.js'
import type { AgentRegistry, AgentState } from './registry.js'
import type { AttemptLog } from './attempts.js'
import { withCommandResourceLock } from './command-locks.js'
import { acquireTaskLeases } from './leases.js'
import { PauseGate } from './pause.js'
import type { TaskQueue, TaskState } from './taskqueue.js'
import type { AgentEvent, SessionUI } from './ui.js'

/** Everything one attempt at a task borrows from the run it belongs to. */
export interface TaskRunEnv {
  plan: DeveloperPlan
  params: WorkerParams
  projectDir: string
  apiKey: string
  abortSignal: AbortSignal
  ui: SessionUI
  queue: TaskQueue
  registry: AgentRegistry
  sessionId: string
  masterAgentId: string
  /** The Worker pool; `null` runs tools in-process, with no OS sandbox. */
  sandbox: Agent | null
  toolCache: ToolCache
  changeHistory: ChangeHistory
  fileLocks: FileLockManager
  commandResourceLocks: FileLockManager
  emitWorker: (event: AgentEvent) => void
  attemptLog: AttemptLog
  /** How this project is built and checked, read once: every pack in a run carries one card. */
  projectCard: string
  /** Each running task's pause switch. */
  pauseGates: Map<string, PauseGate>
  /** The last error each task reported, for the run's result. */
  taskErrors: Map<string, string>
  /** Tasks whose last attempt changed nothing: a retry cannot help. */
  noOpTasks: Set<string>
  /** The worker agent each task is running under, for terminal transitions. */
  taskAgents: Map<string, string>
}

/**
 * Build the function that runs one attempt of one task.
 *
 * The retry policy is not here: the Manager decides whether an attempt gets
 * another. The function returns whether the attempt succeeded.
 */
export function createTaskRunner(env: TaskRunEnv): (task: TaskState) => Promise<boolean> {
  const {
    plan, params, projectDir, apiKey, abortSignal, ui, queue, registry, sessionId, masterAgentId,
    sandbox, toolCache, changeHistory, fileLocks, commandResourceLocks, emitWorker, attemptLog,
    projectCard, pauseGates, taskErrors, noOpTasks, taskAgents,
  } = env
  const isInterrupted = () => abortSignal.aborted
  const workerModel = params.workerModel

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
      await acquireTaskLeases(fileLocks, task, params.readLocks, projectDir)

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
      const upstream = attemptLog.upstreamOf(task)
      const earlier = attemptLog.previous(task.id)
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

      // Recorded now, while the attempt's changes are still on disk: the
      // rollback below is what makes a retry start from a clean tree, and it is
      // also what would erase the evidence.
      attemptLog.record(task, success, attemptEnd)

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


  return runTaskOnce
}
