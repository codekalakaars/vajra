// Chat page: path → permissions (optional skip) → chat.

import { h } from '../router.js'
import { permissionRow, permissionHeader, type Permissions } from '../components/permission-toggle.js'
import { planSteps } from '../components/plan-steps.js'
import type { VajraClient } from '../client.js'

interface PlanStep { index: number; title: string; status: string }
interface ToolCall { id: string; name: string; arguments: string; result?: string; error?: string }

export function chatView(client: VajraClient, params: Record<string, string>): { el: HTMLElement; cleanup: () => void } {
  const sessionId = params.id // undefined for new chat
  const container = h('div', { className: 'chat-container' })

  // --- Setup state ---
  let projectDir = ''
  let permissions: Record<string, Permissions> = {}
  let permissionsSaved = false
  let createdSessionId: string | null = sessionId || null
  let assistantText = ''
  let thinkingText = ''
  let steps: PlanStep[] = []
  let toolCalls: ToolCall[] = []
  let selectedModel = 'openrouter/free'
  let isStreaming = false

  // --- Setup UI (path + permissions) ---
  const setupEl = h('div', { className: 'chat-setup' })
  const pathInput = h('input', { className: 'form-input', type: 'text', placeholder: '/path/to/project' }) as HTMLInputElement
  const pathCheckBtn = h('button', { className: 'btn' }, 'List')
  const modelSelect = h('select', { className: 'form-select' },
    h('optgroup', { label: 'Auto (Recommended)' },
      h('option', { value: 'openrouter/free', selected: 'true' }, 'Auto-route free models'),
    ),
    h('optgroup', { label: 'Strong (1M context)' },
      h('option', { value: 'nvidia/nemotron-3-ultra-550b-a55b:free' }, 'Nemotron 3 Ultra 550B'),
      h('option', { value: 'nvidia/nemotron-3-super-120b-a12b:free' }, 'Nemotron 3 Super 120B'),
      h('option', { value: 'minimax/minimax-m3:free' }, 'MiniMax M3'),
      h('option', { value: 'thinkingmachines/inkling:free' }, 'Inkling'),
    ),
    h('optgroup', { label: 'Fast' },
      h('option', { value: 'nvidia/nemotron-3.5-lightning:free' }, 'Nemotron 3.5 Lightning'),
      h('option', { value: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' }, 'Nemotron 3 Nano 30B'),
      h('option', { value: 'inclusionai/ling-3.0-flash-fin:free' }, 'Ling 3.0 Flash'),
    ),
    h('optgroup', { label: 'Coding' },
      h('option', { value: 'poolside/laguna-s-2.1:free' }, 'Laguna S 2.1'),
      h('option', { value: 'poolside/laguna-xs-2.1:free' }, 'Laguna XS 2.1'),
      h('option', { value: 'cohere/north-mini-code:free' }, 'North Mini Code'),
    ),
    h('optgroup', { label: 'General' },
      h('option', { value: 'z-ai/glm-5.2:free' }, 'GLM 5.2'),
      h('option', { value: 'google/gemma-4-31b-it:free' }, 'Gemma 4 31B'),
      h('option', { value: 'google/gemma-4-26b-a4b-it:free' }, 'Gemma 4 26B'),
      h('option', { value: 'minimax/minimax-m2.7:free' }, 'MiniMax M2.7'),
    ),
  ) as HTMLSelectElement
  modelSelect.addEventListener('change', () => {
    selectedModel = modelSelect.value
    renderChat()
  })
  const permContainer = h('div', { style: 'margin-top: 12px;' })
  const saveBtn = h('button', { className: 'btn btn-primary' }, 'Save Permissions') as HTMLButtonElement
  saveBtn.setAttribute('disabled', 'true')
  const skipBtn = h('button', { className: 'btn' }, 'Skip (read-only)') as HTMLButtonElement
  skipBtn.setAttribute('disabled', 'true')
  const setupMsg = h('div', { style: 'font-size: 12px; color: var(--text-muted); margin-top: 8px;' })

  if (!createdSessionId) {
    const pathRow = h('div', { style: 'display:flex; gap:8px; align-items:center;' }, pathInput, pathCheckBtn)
    const permActions = h('div', { style: 'display:flex; gap:8px; margin-top:8px;' }, saveBtn, skipBtn)
    setupEl.appendChild(h('div', { className: 'chat-setup-header' }, '1. Project path'))
    setupEl.appendChild(pathRow)
    setupEl.appendChild(h('div', { className: 'chat-setup-header', style: 'margin-top:12px;' }, '2. Model'))
    setupEl.appendChild(modelSelect)
    setupEl.appendChild(h('div', { className: 'chat-setup-header', style: 'margin-top:12px;' }, '3. Permissions'))
    setupEl.appendChild(permContainer)
    setupEl.appendChild(permActions)
    setupEl.appendChild(setupMsg)
    container.appendChild(setupEl)
  }

  // Chat area
  const messagesEl = h('div', { className: 'chat-messages' })
  const thinkingEl = h('details', { className: 'thinking-block' })
  const thinkingSummary = h('summary', null, 'Thinking...')
  const thinkingContent = h('div', { className: 'thinking-content' })
  thinkingEl.appendChild(thinkingSummary)
  thinkingEl.appendChild(thinkingContent)
  const planEl = h('div')
  const toolLogEl = h('div')
  const inputRow = h('div', { className: 'chat-input-row' })
  const chatInput = h('textarea', { className: 'form-input chat-input', placeholder: 'Message...' }) as HTMLTextAreaElement
  const sendBtn = h('button', { className: 'btn btn-primary' }, 'Send')
  inputRow.appendChild(chatInput)
  inputRow.appendChild(sendBtn)

  // Disable chat until setup done (optional skip allows immediately)
  function updateChatEnabled() {
    const canChat = !!createdSessionId || permissionsSaved
    // For new chats, require either saved or skipped
    if (!createdSessionId && !permissionsSaved) {
      chatInput.setAttribute('disabled', 'true')
      sendBtn.setAttribute('disabled', 'true')
      chatInput.placeholder = 'Save or skip permissions to start chatting...'
    } else {
      chatInput.removeAttribute('disabled')
      if (client.state === 'connected') sendBtn.removeAttribute('disabled')
      chatInput.placeholder = 'Message...'
    }
  }
  updateChatEnabled()
  client.onStateChange((state) => {
    if (state === 'connected') {
      if (chatInput.getAttribute('disabled') !== 'true' || permissionsSaved || createdSessionId) {
        // keep disabled if still awaiting permissions
        if (permissionsSaved || createdSessionId) sendBtn.removeAttribute('disabled')
      }
    } else {
      sendBtn.setAttribute('disabled', 'true')
    }
  })

  // Path check -> load permissions + scan files
  pathCheckBtn.addEventListener('click', async () => {
    const dir = pathInput.value.trim()
    if (!dir) return
    projectDir = dir
    pathCheckBtn.textContent = 'Listing...'
    setupMsg.textContent = ''
    permContainer.innerHTML = ''
    try {
      const [perms, files] = await Promise.all([
        client.call('project.loadPermissions', { projectDir: dir } as never) as Promise<{ version: number; default: Permissions; files: Record<string, Permissions> }>,
        client.call('project.scan', { projectDir: dir } as never) as Promise<Array<{ name: string; path: string; isDir: boolean; isMasked: boolean }>>,
      ])
      permissions = perms.files || {}
      // Show header + file rows (skip directories and masked files)
      const header = permissionHeader()
      permContainer.appendChild(header)
      const realFiles = files.filter(f => !f.isDir && !f.isMasked)
      if (realFiles.length === 0) {
        permContainer.appendChild(h('div', { style: 'padding:8px; color:var(--text-muted); font-size:13px;' }, 'No scannable files found.'))
      } else {
        for (const f of realFiles) {
          const perm = permissions[f.path] || { read: true, write: false, edit: false, delete: false }
          if (!permissions[f.path]) permissions[f.path] = perm
          permContainer.appendChild(permissionRow(f.path, { ...perm }, (path, key, val) => { permissions[path][key] = val }))
        }
      }
      setupMsg.textContent = `${realFiles.length} file(s) found. Toggle permissions, then Save or Skip.`
      saveBtn.removeAttribute('disabled')
      skipBtn.removeAttribute('disabled')
      updateChatEnabled()
    } catch (e) {
      setupMsg.textContent = String(e)
      setupMsg.style.color = 'var(--danger)'
    } finally {
      pathCheckBtn.textContent = 'List'
    }
  })

  saveBtn.addEventListener('click', async () => {
    if (!projectDir) { setupMsg.textContent = 'Set a project path first.'; return }
    saveBtn.textContent = 'Saving...'
    try {
      const config = { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: permissions }
      await client.call('project.savePermissions', { projectDir, config } as never)
      permissionsSaved = true
      setupMsg.textContent = 'Permissions saved.'
      setupMsg.style.color = 'var(--success)'
      updateChatEnabled()
    } catch (e) {
      setupMsg.textContent = String(e)
      setupMsg.style.color = 'var(--danger)'
    } finally {
      saveBtn.textContent = 'Save Permissions'
    }
  })

  skipBtn.addEventListener('click', () => {
    if (!projectDir) projectDir = pathInput.value.trim() || '/tmp'
    permissions = {}
    permissionsSaved = true
    setupMsg.textContent = 'Skipped — using read-only defaults.'
    setupMsg.style.color = 'var(--text-muted)'
    updateChatEnabled()
  })

  function renderChat() {

    planEl.innerHTML = ''
    if (steps.length > 0) {
      planEl.appendChild(h('h3', { className: 'card-title', style: 'margin-bottom:8px;' }, 'Plan'))
      planEl.appendChild(planSteps(steps.map(s => ({ index: s.index, title: s.title, status: s.status as never }))))
    }
    toolLogEl.innerHTML = ''
    if (toolCalls.length > 0) {
      toolLogEl.appendChild(h('h3', { className: 'card-title' }, 'Tool calls'))
      for (const tc of toolCalls) {
        toolLogEl.appendChild(
          h('div', { className: 'tool-entry' },
            h('div', { className: 'tool-entry-header' }, h('span', { className: 'tool-name' }, tc.name), h('span', { className: `tool-status ${tc.error ? 'error' : tc.result ? 'ok' : ''}` }, tc.error ? 'error' : tc.result ? 'ok' : 'pending')),
            h('div', { className: 'tool-args' }, tc.arguments),
            tc.result ? h('div', { className: 'tool-result' }, tc.result) : null,
            tc.error ? h('div', { className: 'tool-result' }, `Error: ${tc.error}`) : null
          )
        )
      }
    }
    // Thinking block
    if (thinkingText) {
      thinkingContent.textContent = thinkingText
      thinkingEl.style.display = ''
    } else {
      thinkingEl.style.display = 'none'
    }
    messagesEl.innerHTML = ''
    if (assistantText) {
      messagesEl.style.display = ''
      messagesEl.appendChild(h('div', { className: 'chat-bubble assistant' }, assistantText))
    } else {
      messagesEl.style.display = 'none'
    }
  }

  // Push event subscriptions
  const unsubs: Array<() => void> = []
  function targetId() { return createdSessionId }
  unsubs.push(
    client.on('session.planUpdated' as never, (payload: unknown) => {
      const p = payload as { sessionId: string; plan: PlanStep[] }
      if (p.sessionId !== targetId()) return
      steps = p.plan as never
      renderChat()
    }),
    client.on('session.assistantDelta' as never, (payload: unknown) => {
      const p = payload as { sessionId: string; text: string }
      if (p.sessionId !== targetId()) return
      isStreaming = true
      assistantText += p.text
      renderChat()
    }),
    client.on('session.thinkingDelta' as never, (payload: unknown) => {
      const p = payload as { sessionId: string; text: string }
      if (p.sessionId !== targetId()) return
      thinkingText += p.text
      renderChat()
    }),
    client.on('session.toolCall' as never, (payload: unknown) => {
      const p = payload as { sessionId: string; id: string; name: string; arguments: string }
      if (p.sessionId !== targetId()) return
      toolCalls.push({ id: p.id, name: p.name, arguments: p.arguments })
      renderChat()
    }),
    client.on('session.toolResult' as never, (payload: unknown) => {
      const p = payload as { sessionId: string; id: string; result: string; error?: string }
      if (p.sessionId !== targetId()) return
      const tc = toolCalls.find(t => t.id === p.id)
      if (tc) { tc.result = p.result; tc.error = p.error }
      renderChat()
    }),
    client.on('session.stepStatus' as never, (payload: unknown) => {
      const p = payload as { sessionId: string; index: number; status: string }
      if (p.sessionId !== targetId()) return
      const s = steps.find(x => x.index === p.index)
      if (s) s.status = p.status
      renderChat()
    }),
    client.on('session.completed' as never, (payload: unknown) => {
      const p = payload as { sessionId: string }
      if (p.sessionId !== targetId()) return
      isStreaming = false
      renderChat()
    }),
    client.on('session.failed' as never, (payload: unknown) => {
      const p = payload as { sessionId: string; error: string }
      if (p.sessionId !== targetId()) return
      isStreaming = false
      assistantText += `\n\nError: ${p.error}`
      renderChat()
    })
  )

  async function attach() {
    if (!createdSessionId) return
    try {
      const result = (await client.call('session.attach', { sessionId: createdSessionId } as never)) as unknown as {
        session: { status: string; model: string }
        plan: PlanStep[]
        messages: Array<{ role: string; content: string | null; toolName?: string; toolCallId?: string; toolArgs?: string; toolResult?: string }>
        activeStep: number | null
      }
      selectedModel = result.session.model || 'openrouter/free'
      steps = result.plan || []
      if (!isStreaming) {
        assistantText = ''
        toolCalls = []
        for (const m of result.messages || []) {
          if (m.role === 'assistant' && m.content) assistantText += m.content
        }
        toolCalls = (result.messages || [])
          .filter((m): m is typeof m & { toolName: string; toolCallId: string } => m.role === 'tool' && !!m.toolCallId && !!m.toolName)
          .map(m => ({ id: m.toolCallId!, name: m.toolName!, arguments: m.toolArgs || '{}', result: m.toolResult }))
      }
      renderChat()
    } catch (e) {
      assistantText = `Error attaching: ${e}`
      renderChat()
    }
  }

  const unsubState = client.onStateChange((state) => {
    if (state === 'connected' && createdSessionId) attach()
  })

  // Send chat -> create session if needed, else sendMessage
  sendBtn.addEventListener('click', async () => {
    const text = chatInput.value.trim()
    const task = text || 'Start chat session'
    if (!projectDir) {
      setupMsg.textContent = 'Set project path first.'
      setupMsg.style.color = 'var(--danger)'
      return
    }
    chatInput.value = ''
    sendBtn.setAttribute('disabled', 'true')
    try {
      if (!createdSessionId) {
        const permsConfig = { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: permissions }
        const result = (await client.call('session.create', {
          projectDir,
          task,
          model: modelSelect.value,
          permissions: permsConfig,
        } as never)) as unknown as { sessionId: string }
        createdSessionId = result.sessionId
        window.location.hash = `#/session/${createdSessionId}`
        renderChat()
      } else {
        // Follow-up message
        try {
          await client.call('session.sendMessage' as never, { sessionId: createdSessionId, content: text } as never)
        } catch {
          assistantText += `\nYou: ${text}\n(offline — message queued)`
        }
        renderChat()
      }
    } catch (e) {
      assistantText += `\nError: ${e}\n`
      renderChat()
    } finally {
      sendBtn.removeAttribute('disabled')
    }
  })

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendBtn.click()
    }
  })

  // Layout
  const scrollArea = h('div', { className: 'chat-scroll' })
  scrollArea.appendChild(planEl)
  scrollArea.appendChild(thinkingEl)
  scrollArea.appendChild(messagesEl)
  scrollArea.appendChild(toolLogEl)
  container.appendChild(scrollArea)
  container.appendChild(inputRow)

  // If existing session, hide setup, attach
  if (createdSessionId) {
    setupEl.style.display = 'none'
    attach()
  }
  renderChat()

  return {
    el: container,
    cleanup: () => {
      for (const u of unsubs) u()
      unsubState()
    },
  }
}
