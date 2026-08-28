// Tool call log component.

import { h } from '../router.js'

interface ToolCall {
  id: string
  name: string
  arguments: string
  result?: string
  error?: string
}

export function toolCallLog(calls: ToolCall[]): HTMLElement {
  const container = h('div', { className: 'tool-log' })

  for (const call of calls) {
    const statusClass = call.error ? 'error' : call.result ? 'ok' : ''
    const statusText = call.error ? 'error' : call.result ? 'ok' : 'pending'

    const header = h(
      'div',
      { className: 'tool-entry-header' },
      h('span', { className: 'tool-name' }, call.name),
      h('span', { className: `tool-status ${statusClass}` }, statusText)
    )

    const entry = h('div', { className: 'tool-entry' }, header)

    if (call.arguments) {
      entry.appendChild(h('div', { className: 'tool-args' }, call.arguments))
    }

    if (call.result) {
      entry.appendChild(h('div', { className: 'tool-result' }, call.result))
    }

    if (call.error) {
      entry.appendChild(h('div', { className: 'tool-result' }, `Error: ${call.error}`))
    }

    container.appendChild(entry)
  }

  return container
}
