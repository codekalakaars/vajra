import type { SessionUI, TaskEvent } from '../manager/ui.js'

/**
 * A UI that prints to the terminal: the Developer's words as they arrive, a line
 * per task event, and a line per tool call the Developer or a Worker makes.
 *
 * `write` takes a whole line; `writeText` takes streamed text as it comes, with
 * no newline added, so the Developer's reply reads as it is typed.
 */
export function consoleUi(output: {
  write: (line: string) => void
  writeText: (text: string) => void
}): SessionUI {
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
  return {
    info: message => output.write(message),
    success: message => output.write(message),
    error: message => output.write(`error: ${message}`),
    warning: message => output.write(`warning: ${message}`),
    newline: () => output.write(''),
    onTextDelta: text => output.writeText(text),
    onThinkingDelta: () => {},
    finishLine: () => output.writeText('\n'),
    discardBuffer: () => {},
    onTaskEvent: event => output.write(describe(event)),
    onAgentEvent: event => {
      if (event.type === 'tool-start') {
        output.write(`    ${event.agent.taskId ?? event.agent.role} → ${event.tool} ${event.summary}`)
      }
    },
  }
}
