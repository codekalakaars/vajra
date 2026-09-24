import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FileLockManager, ChangeHistory } from '@codekalakaars/vajra-sandbox'
import {
  developerConversationTurn,
  type LaunchHandle,
  type DeveloperTurnResult,
} from '../agent/developer.js'
import { AgentRegistry } from '../agent/registry.js'
import { TaskQueue } from '../agent/taskqueue.js'
import type { OpenRouterMessage } from '../agent/openrouter.js'
import { evaluateSkipIf } from '../tasks/skip.js'
import { computeTaskPermissions, normalizeProjectPath } from '../tasks/permissions.js'
import { executeTask } from '../tasks/execute.js'
import { createToolHandle } from '../tools/handle.js'
import { finalReport } from '../tasks/report.js'
import { launchSandboxSession, type SandboxSession } from '../sandbox/launch.js'
import type { SessionUI } from './ui.js'

const DEFAULT_MAX_RETRIES = 2
const MAX_CONVERSATION_TURNS = 20

export interface SessionOptions {
  task?: string
  apiKey?: string
  model: string
  projectDir: string
  autoConfirm?: boolean
  timeout?: number
  /** Explicit opt-in to run without OS sandbox enforcement. */
  allowUnenforced?: boolean
  /** Host-owned abort (Ctrl-C / TUI interrupt). Aborting finishes the current step. */
  signal?: AbortSignal
  /**
   * Called with a teardown for the sandbox worker as soon as it exists
   * (and with null when the session ends without one) so a host can force
   * quit without orphaning the forked worker.
   */
  onSandboxClose?: (close: (() => void) | null) => void
}

export interface SessionResult {
  /** Process exit code: 0 clean/exit-command, report code after execution, 130 interrupted. */
  exitCode: number
  interrupted: boolean
  /** User typed exit/quit. */
  exited: boolean
}

export function isExitCommand(message: string): boolean {
  const lower = message.trim().toLowerCase()
  return lower === 'exit' || lower === 'quit' || lower === '/exit' || lower === '/quit'
}

/**
 * Interactive developer-agent session, frontend-agnostic. The host supplies a
 * SessionUI (readline for the CLI, Ink for the TUI) and an optional abort
 * signal; this function never touches process.stdin/stdout directly.
 */
export async function runSession(
  options: SessionOptions,
  ui: SessionUI,
): Promise<SessionResult> {
  if (!options.apiKey) {
    const requiredKey =
      options.model.startsWith('zen/') || options.model.startsWith('go/')
        ? 'OPENCODE_API_KEY'
        : 'OPENROUTER_API_KEY'
    ui.error(
      `No API key provided for model '${options.model}'. Set ${requiredKey} or use --api-key`,
    )
    return { exitCode: 1, interrupted: false, exited: false }
  }

  const projectDir = resolve(options.projectDir)
  if (!existsSync(projectDir)) {
    ui.error(`Project directory does not exist: ${projectDir}`)
    return { exitCode: 1, interrupted: false, exited: false }
  }

  const abortSignal = options.signal ?? new AbortController().signal
  const isInterrupted = () => abortSignal.aborted
  let exited = false

  // Declared early so a host force-quit can close the worker even before
  // launchSandboxSession resolves.
  let sandbox: SandboxSession | null = null
  options.onSandboxClose?.(null)
  const notifySandboxClose = () => options.onSandboxClose?.(() => sandbox?.close())

  ui.banner()

  const sessionId = randomUUID()
  const registry = new AgentRegistry()
  const fileLocks = new FileLockManager()
  // D1: ChangeHistory always records against the resolved projectDir.
  const changeHistory = new ChangeHistory(projectDir)

  const masterAgent = registry.createAgent(sessionId, 'master', 'Orchestrate task execution')
  registry.updateStatus(masterAgent.id, 'running')

  ui.info(`Model: ${options.model}`)
  ui.info(`Timeout: ${options.timeout ?? 300}s per task`)

  // Q: fork a confined worker for tool execution. Parent never calls
  // applySandbox itself. Fail closed unless the user explicitly opted into
  // unenforced mode; only that explicit mode may fall back in-process.
  const allowUnenforced = options.allowUnenforced ?? false
  try {
    sandbox = await launchSandboxSession(projectDir, sessionId, {
      allowUnenforced,
      requireEnforced: !allowUnenforced,
    })
    notifySandboxClose()
    if (sandbox.report.enforced) {
      ui.info(`Sandbox: ${sandbox.report.mechanism}`)
    } else {
      ui.warning(
        `Sandbox not enforced (${sandbox.report.mechanism}) — tools run with app-level permissions only`,
      )
    }
    for (const w of sandbox.report.warnings) ui.warning(w)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!allowUnenforced) {
      ui.error(`Sandbox unavailable: ${message}`)
      ui.error('Re-run with --allow-unenforced to continue without OS sandbox enforcement.')
      sandbox?.close()
      return { exitCode: 1, interrupted: false, exited: false }
    }
    ui.warning(
      `Sandbox unavailable: ${message} — falling back to in-process tools (explicit --allow-unenforced)`,
    )
  }

  const finish = (exitCode: number): SessionResult => {
    registry.updateStatus(masterAgent.id, isInterrupted() ? 'failed' : 'done')
    sandbox?.close()
    let code = exitCode
    if (isInterrupted() && code === 0) code = 130
    if (isInterrupted()) {
      ui.warning('Session interrupted. Progress has been saved.')
    }
    return { exitCode: code, interrupted: isInterrupted(), exited }
  }

  const developerHandle: LaunchHandle = sandbox?.handle ?? createToolHandle(projectDir)

  const messages: OpenRouterMessage[] = []
  const summaryIndex: Array<{
    path: string
    symbols: string[]
    preview: string
    lineCount: number
    importCount: number
    exportCount: number
  }> = []

  let initialMessage = options.task
  let initialKind: 'first' | 'reentry' = 'first'
  if (!initialMessage) {
    initialMessage = await ui.askInitialTask(initialKind)
  }

  // D7: honour exit/quit at the first prompt, not only on later turns.
  while (!initialMessage || isExitCommand(initialMessage)) {
    if (initialMessage && isExitCommand(initialMessage)) {
      ui.info('Goodbye!')
      exited = true
      return finish(0)
    }
    initialKind = 'reentry'
    initialMessage = await ui.askInitialTask(initialKind)
  }

  ui.info(`\n🔍 Scanning project in ${projectDir}...`)
  ui.info(`💬 Starting conversation with developer...\n`)

  let result: DeveloperTurnResult | undefined
  let userMessage = initialMessage

  let turn = 0
  for (turn = 0; turn < MAX_CONVERSATION_TURNS; turn++) {
    if (isInterrupted()) break

    try {
      result = await developerConversationTurn({
        sessionId,
        projectDir,
        userMessage,
        model: options.model,
        apiKey: options.apiKey,
        handle: developerHandle,
        messages,
        summaryIndex,
        onTextDelta: text => ui.onTextDelta(text),
        onThinkingDelta: text => ui.onThinkingDelta(text),
        isInterrupted,
        signal: abortSignal,
      })
    } catch (e) {
      if (isInterrupted()) break
      ui.error(`API error: ${e instanceof Error ? e.message : String(e)}`)
      ui.warning('Check your API key and network connection.')
      break
    }

    ui.finishLine()

    if (result.type === 'plan') {
      ui.showPlan(result.plan)

      let confirmed = false
      if (options.autoConfirm) {
        ui.info('Auto-confirming plan (--yes flag)\n')
        confirmed = true
      } else {
        // D8: confirmation is [y/N] — anything other than yes rejects.
        confirmed = (await ui.askConfirmPlan()) === 'y'
      }

      if (!confirmed) {
        ui.warning('Plan rejected. What would you like to change?')
        userMessage = await ui.askRejectFeedback()
        if (userMessage && isExitCommand(userMessage)) {
          ui.info('Goodbye!')
          exited = true
          return finish(0)
        }
        continue
      }

      ui.info('\n🚀 Executing tasks...\n')

      // D3: queue default timeout comes from the CLI -t flag (seconds).
      const queue = new TaskQueue(sessionId, options.timeout ?? 300)
      for (const task of result.plan.tasks) {
        queue.addTask(task)
      }

      let completedCount = 0
      const totalCount = result.plan.tasks.length

      while (true) {
        if (isInterrupted()) break
        const status = queue.getStatus()
        if (status.done + status.failed + status.skipped >= status.total) break

        const readyTasks = queue.getReadyTasks()

        // No ready tasks but unfinished work remains (unresolvable deps) —
        // break so the final report surfaces them as pending (D5/§27).
        if (readyTasks.length === 0) {
          break
        }

        for (const task of readyTasks) {
          if (isInterrupted()) break

          if (task.skipIf && task.skipIf.length > 0) {
            const shouldSkip = await evaluateSkipIf(task.skipIf, projectDir)
            if (shouldSkip) {
              queue.skipTask(task.id)
              completedCount++
              ui.onTaskEvent({ type: 'skipped', title: task.title })
              continue
            }
          }

          const allTaskFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
          const allTaskPaths = [...allTaskFiles, ...task.createDir]
          // D4: wait for locks instead of permanently skipping on conflict.
          await fileLocks.acquireOrWait(allTaskPaths, task.id, 'write')

          const agent = registry.createAgent(sessionId, 'worker', task.title, masterAgent.id)
          queue.assignTask(task.id, agent.id)
          registry.updateStatus(agent.id, 'running')
          queue.startTask(task.id)

          ui.onTaskEvent({
            type: 'start',
            index: completedCount + 1,
            total: totalCount,
            title: task.title,
          })

          // D2: track dirty-set via onMutate rather than changeHistory.hasChanges
          // alone (baseline records can make hasChanges unreliable across rollbacks).
          const permissions = computeTaskPermissions(task, projectDir)
          let dirty = false
          const permissionLookup = (path: string) =>
            permissions[normalizeProjectPath(projectDir, path)] ?? null

          let taskHandle: LaunchHandle
          if (sandbox) {
            sandbox.setTaskPermissions(permissionLookup)
            sandbox.setOnMutate(() => {
              dirty = true
            })
            taskHandle = sandbox.handle
          } else {
            taskHandle = createToolHandle(projectDir, {
              permissions: path => {
                const key = normalizeProjectPath(projectDir, path)
                return permissions[key] ?? { read: false, write: false, edit: false, delete: false }
              },
              onMutate: () => {
                dirty = true
              },
            })
          }

          for (const filePath of allTaskFiles) {
            await changeHistory.recordBefore(task.id, filePath)
          }

          let success = false
          let retries = 0
          const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES

          while (retries <= maxRetries) {
            dirty = false
            success = await executeTask(
              agent.id,
              task,
              taskHandle,
              options.apiKey,
              options.model,
              ui,
              changeHistory,
              queue,
              registry,
              sessionId,
              fileLocks,
              projectDir,
              abortSignal,
            )

            if (success) break

            if (!dirty && !changeHistory.hasChanges(task.id)) {
              ui.onTaskEvent({ type: 'no-changes', title: task.title })
              break
            }

            if (retries < maxRetries) {
              // rollback already drops the task's change set; re-baseline so
              // the next attempt starts from the restored files.
              await changeHistory.rollback(task.id)
              for (const filePath of allTaskFiles) {
                await changeHistory.recordBefore(task.id, filePath)
              }
              dirty = false
              ui.onTaskEvent({
                type: 'retry',
                title: task.title,
                attempt: retries + 1,
                max: maxRetries,
              })
              retries++
            } else {
              break
            }
          }

          if (success) {
            queue.completeTask(task.id, true)
            registry.updateStatus(agent.id, 'done')
            ui.onTaskEvent({ type: 'done', title: task.title })
          } else {
            if (dirty || changeHistory.hasChanges(task.id)) {
              await changeHistory.rollback(task.id)
            }
            queue.failTask(task.id)
            registry.updateStatus(agent.id, 'failed')
            ui.onTaskEvent({ type: 'failed', title: task.title })
          }

          fileLocks.release(task.id)
          completedCount++
        }
      }

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
      return finish(report.exitCode)
    }

    userMessage = await ui.askUserMessage()

    if (!userMessage) {
      ui.warning('Empty message. Type "exit" to quit.')
      userMessage = 'exit'
    }

    if (isExitCommand(userMessage)) {
      ui.info('Goodbye!')
      exited = true
      return finish(0)
    }
  }

  if (turn >= MAX_CONVERSATION_TURNS && !isInterrupted() && result?.type !== 'plan') {
    // D9: we did not start execution after the turn cap — don't claim we did.
    ui.warning('Reached the 20-turn conversation limit. Continuing may be limited.')
  }

  return finish(0)
}
