import * as readline from 'node:readline'
import { existsSync } from 'node:fs'
import { TerminalStreamer } from './streaming.js'
import { developerConversationTurn, type LaunchHandle, type DeveloperTurnResult } from './agent/developer.js'
import { AgentRegistry } from './agent/registry.js'
import { TaskQueue } from './agent/taskqueue.js'
import type { OpenRouterMessage } from './agent/openrouter.js'
import { FileLockManager, ChangeHistory } from '@codekalakaars/vajra-sandbox'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { evaluateSkipIf } from './tasks/skip.js'
import { computeTaskPermissions, normalizeProjectPath } from './tasks/permissions.js'
import { executeTask } from './tasks/execute.js'
import { createToolHandle } from './tools/handle.js'
import { finalReport } from './tasks/report.js'
import { launchSandboxSession, type SandboxSession } from './sandbox/launch.js'

export interface RunOptions {
  task?: string
  apiKey?: string
  model: string
  verbose: boolean
  projectDir: string
  autoConfirm?: boolean
  timeout?: number
}

const DEFAULT_MAX_RETRIES = 2

function isExitCommand(message: string): boolean {
  const lower = message.trim().toLowerCase()
  return lower === 'exit' || lower === 'quit' || lower === '/exit' || lower === '/quit'
}

export async function runCommand(options: RunOptions): Promise<void> {
  const streamer = new TerminalStreamer(options.verbose)

  if (!options.apiKey) {
    streamer.error('No API key provided. Set OPENROUTER_API_KEY or OPENCODE_API_KEY, or use --api-key')
    process.exit(1)
  }

  const projectDir = resolve(options.projectDir)
  if (!existsSync(projectDir)) {
    streamer.error(`Project directory does not exist: ${projectDir}`)
    process.exit(1)
  }

  // D6: first SIGINT aborts in-flight work; second exits immediately with 130.
  const abortController = new AbortController()
  let interrupted = false
  let sigintCount = 0
  // Declared early so the SIGINT handler can close the worker if it fires
  // before launchSandboxSession resolves.
  let sandbox: SandboxSession | null = null
  const onSigInt = () => {
    sigintCount++
    if (sigintCount >= 2) {
      sandbox?.close()
      process.exit(130)
    }
    interrupted = true
    abortController.abort()
    streamer.warning('\nInterrupted. Finishing current step — press Ctrl-C again to force quit.')
  }
  process.on('SIGINT', onSigInt)

  streamer.banner()

  const sessionId = randomUUID()
  const registry = new AgentRegistry()
  const fileLocks = new FileLockManager()
  // D1: ChangeHistory always records against the resolved projectDir.
  const changeHistory = new ChangeHistory(projectDir)

  const masterAgent = registry.createAgent(sessionId, 'master', 'Orchestrate task execution')
  registry.updateStatus(masterAgent.id, 'running')

  streamer.info(`Model: ${options.model}`)
  streamer.info(`Timeout: ${options.timeout ?? 300}s per task`)

  // Q: fork a confined worker for tool execution. Parent never calls
  // applySandbox itself. Fall back to in-process handles if the worker
  // cannot start (e.g. platform refuses and allowUnenforced is off).
  try {
    sandbox = await launchSandboxSession(projectDir, sessionId, { allowUnenforced: true })
    if (sandbox.report.enforced) {
      streamer.info(`Sandbox: ${sandbox.report.mechanism}`)
    } else {
      streamer.warning(
        `Sandbox not enforced (${sandbox.report.mechanism}) — tools run with app-level permissions only`,
      )
    }
    for (const w of sandbox.report.warnings) streamer.warning(w)
  } catch (e) {
    streamer.warning(
      `Sandbox unavailable: ${e instanceof Error ? e.message : String(e)} — falling back to in-process tools`,
    )
  }

  const developerHandle: LaunchHandle = sandbox?.handle ?? createToolHandle(projectDir)

  const messages: OpenRouterMessage[] = []
  const summaryIndex: Array<{ path: string; symbols: string[]; preview: string; lineCount: number; importCount: number; exportCount: number }> = []

  let initialMessage = options.task
  if (!initialMessage) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    initialMessage = await new Promise<string>(resolve => {
      rl.question('\x1b[1mWhat would you like me to work on? \x1b[0m', answer => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }

  // D7: honour exit/quit at the first prompt, not only on later turns.
  if (initialMessage && isExitCommand(initialMessage)) {
    streamer.info('Goodbye!')
    process.removeListener('SIGINT', onSigInt)
    sandbox?.close()
    process.exit(0)
  }

  while (!initialMessage) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    initialMessage = await new Promise<string>(resolve => {
      rl.question('\x1b[1mPlease enter a task (or type "exit" to quit): \x1b[0m', answer => {
        rl.close()
        resolve(answer.trim())
      })
    })
    if (initialMessage && isExitCommand(initialMessage)) {
      streamer.info('Goodbye!')
      process.removeListener('SIGINT', onSigInt)
      sandbox?.close()
      process.exit(0)
    }
  }

  streamer.info(`\n🔍 Scanning project in ${projectDir}...`)
  streamer.info(`💬 Starting conversation with developer...\n`)

  let result: DeveloperTurnResult | undefined
  let userMessage = initialMessage

  let turn = 0
  for (turn = 0; turn < 20; turn++) {
    if (interrupted) break

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
        onTextDelta: text => streamer.onTextDelta(text),
        onThinkingDelta: text => streamer.onThinkingDelta(text),
        isInterrupted: () => interrupted,
        signal: abortController.signal,
      })
    } catch (e) {
      if (abortController.signal.aborted || interrupted) break
      streamer.error(`API error: ${e instanceof Error ? e.message : String(e)}`)
      streamer.warning('Check your API key and network connection.')
      break
    }

    streamer.finishLine()

    if (result.type === 'plan') {
      streamer.planSummary(result.plan)

      if (options.autoConfirm) {
        streamer.info('Auto-confirming plan (--yes flag)\n')
      } else {
        // D8: confirmation is [y/N] — anything other than yes rejects.
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const confirm = await new Promise<string>(resolve => {
          rl.question('\x1b[1m? Confirm plan? [y/N] \x1b[0m', answer => {
            rl.close()
            resolve(answer.trim().toLowerCase())
          })
        })

        if (confirm !== 'y' && confirm !== 'yes') {
          streamer.warning('Plan rejected. What would you like to change?')
          userMessage = await new Promise<string>(resolve => {
            const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout })
            rl2.question('\x1b[1mFeedback: \x1b[0m', answer => {
              rl2.close()
              resolve(answer.trim())
            })
          })
          if (userMessage && isExitCommand(userMessage)) break
          continue
        }
      }

      streamer.info('\n🚀 Executing tasks...\n')

      // D3: queue default timeout comes from the CLI -t flag (seconds).
      const queue = new TaskQueue(sessionId, options.timeout ?? 300)
      for (const task of result.plan.tasks) {
        queue.addTask(task)
      }

      let completedCount = 0
      const totalCount = result.plan.tasks.length

      while (true) {
        if (interrupted) break
        const status = queue.getStatus()
        if (status.done + status.failed + status.skipped >= status.total) break

        const readyTasks = queue.getReadyTasks()

        // No ready tasks but unfinished work remains (unresolvable deps) —
        // break so the final report surfaces them as pending (D5/§27).
        if (readyTasks.length === 0) {
          break
        }

        for (const task of readyTasks) {
          if (interrupted) break

          if (task.skipIf && task.skipIf.length > 0) {
            const shouldSkip = await evaluateSkipIf(task.skipIf, projectDir)
            if (shouldSkip) {
              queue.skipTask(task.id)
              completedCount++
              streamer.warning(`Skipped: ${task.title}`)
              continue
            }
          }

          const allTaskFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
          // D4: wait for locks instead of permanently skipping on conflict.
          await fileLocks.acquireOrWait(allTaskFiles, task.id, 'write')

          const agent = registry.createAgent(sessionId, 'worker', task.title, masterAgent.id)
          queue.assignTask(task.id, agent.id)
          registry.updateStatus(agent.id, 'running')
          queue.startTask(task.id)

          streamer.info(`\n⏳ [${completedCount + 1}/${totalCount}] ${task.title}`)

          // D2: track dirty-set via onMutate rather than changeHistory.hasChanges
          // alone (baseline records can make hasChanges unreliable across rollbacks).
          const permissions = computeTaskPermissions(task, projectDir)
          let dirty = false
          const permissionLookup = (path: string) =>
            permissions[normalizeProjectPath(projectDir, path)] ??
            null

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
              streamer,
              changeHistory,
              queue,
              registry,
              sessionId,
              fileLocks,
              projectDir,
              abortController.signal,
            )

            if (success) break

            if (!dirty && !changeHistory.hasChanges(task.id)) {
              streamer.warning(`  No changes made - skipping retry for "${task.title}"`)
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
              streamer.warning(`  Retrying (${retries + 1}/${maxRetries})...`)
              retries++
            } else {
              break
            }
          }

          if (success) {
            queue.completeTask(task.id, true)
            registry.updateStatus(agent.id, 'done')
            streamer.success(`Done: ${task.title}`)
          } else {
            if (dirty || changeHistory.hasChanges(task.id)) {
              await changeHistory.rollback(task.id)
            }
            queue.failTask(task.id)
            registry.updateStatus(agent.id, 'failed')
            streamer.error(`Failed: ${task.title}`)
          }

          fileLocks.release(task.id)
          completedCount++
        }
      }

      const finalStatus = queue.getStatus()
      console.log('')
      streamer.info('📊 Results:')
      const report = finalReport(finalStatus)
      for (const line of report.lines) {
        if (report.exitCode === 0) streamer.success(line)
        else streamer.warning(line)
      }
      console.log('')
      if (report.exitCode === 0) {
        streamer.success('✅ Done!')
      } else {
        streamer.error('Completed with failures or pending tasks.')
      }
      process.exitCode = report.exitCode
      break
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    userMessage = await new Promise<string>(resolve => {
      rl.question('\x1b[1mYou: \x1b[0m', answer => {
        rl.close()
        resolve(answer.trim())
      })
    })

    if (!userMessage) {
      streamer.warning('Empty message. Type "exit" to quit.')
      userMessage = 'exit'
    }

    if (isExitCommand(userMessage)) {
      streamer.info('Goodbye!')
      break
    }
  }

  if (turn >= 20 && !interrupted && result?.type !== 'plan') {
    // D9: we did not start execution after the turn cap — don't claim we did.
    streamer.warning('Reached the 20-turn conversation limit. Continuing may be limited.')
  }

  registry.updateStatus(masterAgent.id, interrupted ? 'failed' : 'done')
  process.removeListener('SIGINT', onSigInt)
  sandbox?.close()
  if (interrupted) {
    streamer.warning('Session interrupted. Progress has been saved.')
    if (process.exitCode === undefined || process.exitCode === 0) {
      process.exitCode = 130
    }
  }
}
