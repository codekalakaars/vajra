import * as readline from 'node:readline'
import { TerminalStreamer } from './streaming.js'
import { runSession, isExitCommand } from './session/service.js'
import type { SessionUI, TaskEvent } from './session/ui.js'

export { isExitCommand }

export interface RunOptions {
  task?: string
  apiKey?: string
  model: string
  verbose: boolean
  projectDir: string
  autoConfirm?: boolean
  timeout?: number
  /** Explicit opt-in to run without OS sandbox enforcement. */
  allowUnenforced?: boolean
}

function ask(message: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<string>(resolve => {
    rl.question(message, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * CLI adapter: TerminalStreamer for output, readline for prompts, SIGINT for
 * interrupt. All orchestration lives in session/service.ts.
 */
export async function runCommand(options: RunOptions): Promise<void> {
  const streamer = new TerminalStreamer(options.verbose)

  const ui: SessionUI = {
    banner: () => streamer.banner(),
    info: message => streamer.info(message),
    success: message => streamer.success(message),
    error: message => streamer.error(message),
    warning: message => streamer.warning(message),
    newline: () => streamer.newline(),
    onTextDelta: text => streamer.onTextDelta(text),
    onThinkingDelta: text => streamer.onThinkingDelta(text),
    finishLine: () => streamer.finishLine(),
    discardBuffer: () => streamer.discardBuffer(),
    askInitialTask: kind =>
      kind === 'first'
        ? ask('\x1b[1mWhat would you like me to work on? \x1b[0m')
        : ask('\x1b[1mPlease enter a task (or type "exit" to quit): \x1b[0m'),
    askUserMessage: () => ask('\x1b[1mYou: \x1b[0m'),
    showPlan: plan => streamer.planSummary(plan),
    askConfirmPlan: async () => {
      const confirm = (await ask('\x1b[1m? Confirm plan? [y/N] \x1b[0m')).toLowerCase()
      // D8: confirmation is [y/N] — anything other than yes rejects.
      return confirm === 'y' || confirm === 'yes' ? 'y' : 'n'
    },
    askRejectFeedback: () => ask('\x1b[1mFeedback: \x1b[0m'),
    onTaskEvent: (event: TaskEvent) => {
      switch (event.type) {
        case 'start':
          streamer.info(`\n⏳ [${event.index}/${event.total}] ${event.title}`)
          break
        case 'done':
          streamer.success(`Done: ${event.title}`)
          break
        case 'failed':
          streamer.error(`Failed: ${event.title}`)
          break
        case 'skipped':
          streamer.warning(`Skipped: ${event.title}`)
          break
        case 'retry':
          streamer.warning(`  Retrying (${event.attempt}/${event.max})...`)
          break
        case 'no-changes':
          streamer.warning(`  No changes made - skipping retry for "${event.title}"`)
          break
      }
    },
  }

  // D6: first SIGINT aborts in-flight work; second exits immediately with 130.
  const abortController = new AbortController()
  let sigintCount = 0
  // Assigned via onSandboxClose so a second Ctrl-C can close the worker even
  // if launchSandboxSession is still in flight.
  let forceCloseSandbox: (() => void) | null = null
  const onSigInt = () => {
    sigintCount++
    if (sigintCount >= 2) {
      forceCloseSandbox?.()
      process.exit(130)
    }
    abortController.abort()
    streamer.warning('\nInterrupted. Finishing current step — press Ctrl-C again to force quit.')
  }
  process.on('SIGINT', onSigInt)

  try {
    const result = await runSession(
      {
        task: options.task,
        apiKey: options.apiKey,
        model: options.model,
        projectDir: options.projectDir,
        autoConfirm: options.autoConfirm,
        timeout: options.timeout,
        allowUnenforced: options.allowUnenforced,
        signal: abortController.signal,
        onSandboxClose: close => {
          forceCloseSandbox = close
        },
      },
      ui,
    )
    if (result.exitCode !== 0) process.exitCode = result.exitCode
  } finally {
    process.removeListener('SIGINT', onSigInt)
  }
}
