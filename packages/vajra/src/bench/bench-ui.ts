import type { SessionUI, TaskEvent } from '../manager/ui.js'
import { type BenchRecorder } from './metrics.js'
import { BenchOptions } from './run.js'

/**
 * A UI that measures instead of drawing.
 *
 * Every event goes to the recorder — the recorder *is* the measurement, read off
 * the same stream the CLI renderer prints, so a score cannot describe a different
 * run than the one it came from. Output is a line per task unless `verbose`.
 */
export function benchUi(recorder: BenchRecorder, options: BenchOptions): SessionUI {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const describe = (event: TaskEvent): string => {
    switch (event.type) {
      case 'start':
        return `  [${event.index}/${event.total}] ${event.title}`
      case 'done':
        return `  done: ${event.title}`
      case 'failed':
        return `  FAILED: ${event.title}`
      case 'skipped':
        return `  skipped: ${event.title}`
      case 'retry':
        return `  retry ${event.attempt}/${event.max}: ${event.title}`
      case 'no-changes':
        return `  no changes: ${event.title}`
    }
  }
  const noPrompt = async (what: string): Promise<never> => {
    throw new Error(`A bench run takes no input, but something asked for ${what}`)
  }
  return {
    banner: () => {},
    info: message => write(message),
    success: message => write(message),
    error: message => write(`error: ${message}`),
    warning: message => write(`warning: ${message}`),
    newline: () => {},
    restoredTurn: () => {},
    onTextDelta: text => {
      if (options.verbose) write(text)
    },
    onThinkingDelta: text => {
      if (options.verbose) write(`thinking: ${text}`)
    },
    finishLine: () => {},
    discardBuffer: () => {},
    askInitialTask: () => noPrompt('an initial task'),
    askUserMessage: () => noPrompt('a message'),
    showPlan: () => {},
    askConfirmPlan: () => noPrompt('plan confirmation'),
    askRejectFeedback: () => noPrompt('rejection feedback'),
    onTaskEvent: event => {
      recorder.taskEvent(event)
      write(describe(event))
    },
    onAgentEvent: event => {
      recorder.agentEvent(event)
      if (!options.verbose) return
      if (event.type === 'tool-start') {
        write(`    ${event.agent.taskId ?? event.agent.role} → ${event.tool} ${event.summary}`)
      } else if (event.type === 'tool-end') {
        write(`    ${event.agent.taskId ?? event.agent.role} ← ${event.tool} ${event.detail ?? ''}`)
      }
    },
  }
}
