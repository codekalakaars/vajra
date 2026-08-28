// Session detail view with real-time updates and reconnect/replay.

import { h } from '../router.js'
import { statusBadge } from '../components/status-badge.js'
import { planSteps } from '../components/plan-steps.js'
import { toolCallLog } from '../components/tool-call-log.js'
import type { VajraClient } from '../client.js'

interface PlanStep {
  index: number
  title: string
  status: string
}

interface ToolCall {
  id: string
  name: string
  arguments: string
  result?: string
  error?: string
}

interface SessionData {
  sessionId: string
  projectDir: string
  task: string
  status: string
}

interface AttachMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  toolName?: string
  toolCallId?: string
  toolArgs?: string
  toolResult?: string
  createdAt: number
}

export function sessionDetailView(client: VajraClient, params: Record<string, string>): { el: HTMLElement; cleanup: () => void } {
  const container = h('div')
  const sessionId = params.id

  // State
  let steps: PlanStep[] = []
  let toolCalls: ToolCall[] = []
  let assistantText = ''
  let sessionData: SessionData | null = null
  let sandboxEnforced = true

  // UI elements
  const statusContainer = h('span')
  const planContainer = h('div')
  const assistantContainer = h('div', { className: 'assistant-text', id: 'assistant-text' }, 'Waiting for plan...')
  const toolLogContainer = h('div')
  const sandboxIndicator = h('div', { className: 'sandbox-status' })
  const stopBtn = h('button', { className: 'btn btn-danger' }, 'Stop')

  function renderAll() {
    // Status
    statusContainer.innerHTML = ''
    if (sessionData) {
      statusContainer.appendChild(statusBadge(sessionData.status))
    }

    // Sandbox
    sandboxIndicator.innerHTML = ''
    sandboxIndicator.appendChild(
      h('div', { className: `sandbox-icon ${sandboxEnforced ? 'enforced' : 'unenforced'}` })
    )
    sandboxIndicator.appendChild(
      h('span', null, `Sandbox: ${sandboxEnforced ? 'Enforced' : 'Unenforced'}`)
    )

    // Plan
    planContainer.innerHTML = ''
    if (steps.length > 0) {
      planContainer.appendChild(h('h3', { className: 'card-title', style: 'margin-bottom: 12px;' }, 'Plan'))
      planContainer.appendChild(planSteps(steps.map(s => ({
        index: s.index,
        title: s.title,
        status: s.status as 'pending' | 'active' | 'done' | 'skipped',
      }))))
    }

    // Assistant text
    if (assistantText) {
      assistantContainer.textContent = assistantText
    }

    // Tool calls
    toolLogContainer.innerHTML = ''
    if (toolCalls.length > 0) {
      toolLogContainer.appendChild(h('h3', { className: 'card-title', style: 'margin-bottom: 12px;' }, 'Tool Calls'))
      toolLogContainer.appendChild(toolCallLog(toolCalls))
    }
  }

  // Subscribe to push events
  const unsubscribers = [
    client.on('session.planUpdated', (payload) => {
      if ((payload as any).sessionId !== sessionId) return
      steps = (payload as any).plan
      renderAll()
    }),

    client.on('session.assistantDelta', (payload) => {
      if ((payload as any).sessionId !== sessionId) return
      assistantText += (payload as any).text
      renderAll()
    }),

    client.on('session.toolCall', (payload) => {
      if ((payload as any).sessionId !== sessionId) return
      toolCalls.push({
        id: (payload as any).id,
        name: (payload as any).name,
        arguments: (payload as any).arguments,
      })
      renderAll()
    }),

    client.on('session.toolResult', (payload) => {
      if ((payload as any).sessionId !== sessionId) return
      const call = toolCalls.find(c => c.id === (payload as any).id)
      if (call) {
        call.result = (payload as any).result
        call.error = (payload as any).error
      }
      renderAll()
    }),

    client.on('session.stepStatus', (payload) => {
      if ((payload as any).sessionId !== sessionId) return
      const step = steps.find(s => s.index === (payload as any).index)
      if (step) {
        step.status = (payload as any).status
      }
      renderAll()
    }),

    client.on('session.sandboxStatus', (payload) => {
      if ((payload as any).sessionId !== sessionId) return
      sandboxEnforced = (payload as any).enforced
      renderAll()
    }),

    client.on('session.completed', (payload) => {
      if ((payload as any).sessionId !== sessionId) return
      if (sessionData) sessionData.status = 'done'
      renderAll()
    }),

    client.on('session.failed', (payload) => {
      if ((payload as any).sessionId !== sessionId) return
      if (sessionData) sessionData.status = 'failed'
      assistantText += `\n\nError: ${(payload as any).error}`
      renderAll()
    }),
  ]

  // Attach to session — resets state from DB (source of truth)
  async function attach() {
    try {
      const result = await client.call('session.attach', { sessionId }) as {
        session: SessionData
        plan: PlanStep[]
        sandbox: { enforced: boolean } | null
        messages: AttachMessage[]
        activeStep: number | null
      }

      // Reset state from DB
      sessionData = result.session
      steps = result.plan || []
      assistantText = ''
      toolCalls = []

      // Rebuild sandbox status
      if (result.sandbox) {
        sandboxEnforced = result.sandbox.enforced
      }

      // Rebuild assistant text from persisted messages
      for (const msg of result.messages || []) {
        if (msg.role === 'assistant' && msg.content) {
          assistantText += msg.content
        }
      }

      // Rebuild tool calls from persisted messages
      toolCalls = (result.messages || [])
        .filter((m): m is AttachMessage & { toolCallId: string; toolName: string } =>
          m.role === 'tool' && !!m.toolCallId && !!m.toolName
        )
        .map((m) => ({
          id: m.toolCallId,
          name: m.toolName,
          arguments: m.toolArgs || '{}',
          result: m.toolResult,
        }))

      renderAll()
    } catch (err) {
      assistantText = `Error attaching: ${err}`
      renderAll()
    }
  }

  // Re-attach on reconnect — DB is the source of truth
  const unsubState = client.onStateChange((state) => {
    if (state === 'connected') {
      attach()
    }
  })

  // Stop button
  stopBtn.addEventListener('click', async () => {
    try {
      await client.call('session.stop', { sessionId })
      if (sessionData) sessionData.status = 'stopped'
      renderAll()
    } catch {
      // Ignore stop errors
    }
  })

  // Build layout
  container.appendChild(
    h('div', { style: 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px;' },
      h('h2', { className: 'card-title' }, `Session ${sessionId.slice(0, 8)}`),
      statusContainer,
      stopBtn
    )
  )

  if (sessionData) {
    container.appendChild(
      h('div', { style: 'color: var(--text-secondary); margin-bottom: 16px;' },
        h('span', null, `Project: ${sessionData.projectDir}`),
        h('span', { style: 'margin: 0 8px;' }, '\u2022'),
        h('span', null, sessionData.task)
      )
    )
  }

  container.appendChild(sandboxIndicator)

  container.appendChild(
    h('div', { className: 'card' },
      h('h3', { className: 'card-title', style: 'margin-bottom: 12px;' }, 'Assistant'),
      assistantContainer
    )
  )

  container.appendChild(
    h('div', { className: 'card' },
      planContainer
    )
  )

  container.appendChild(
    h('div', { className: 'card' },
      toolLogContainer
    )
  )

  attach()

  return {
    el: container,
    cleanup: () => {
      for (const unsub of unsubscribers) unsub()
      unsubState()
    },
  }
}
