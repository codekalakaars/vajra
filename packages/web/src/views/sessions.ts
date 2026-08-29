// Sessions list view.

import { h } from '../router.js'
import { statusBadge } from '../components/status-badge.js'
import type { VajraClient } from '../client.js'

interface Session {
  sessionId: string
  projectDir: string
  task: string
  status: string
  createdAt: string
}

export function sessionsView(client: VajraClient): HTMLElement {
  const container = h('div')
  const tableContainer = h('div')
  const newBtn = h('button', { className: 'btn btn-primary' }, '+ New Session')
  const errorDiv = h('div', { style: 'color: var(--danger); margin-top: 8px; display: none;' })

  let sessions: Session[] = []

  async function loadSessions() {
    errorDiv.style.display = 'none'
    tableContainer.innerHTML = ''

    try {
      sessions = await client.call('session.list', {}) as Session[]

      if (sessions.length === 0) {
        tableContainer.appendChild(
          h('div', { className: 'empty-state' },
            h('p', null, 'No sessions yet.'),
            h('button', { className: 'btn btn-primary', onClick: () => showModal() }, 'Create your first session')
          )
        )
        return
      }

      const table = h('table', { className: 'session-table' })
      const thead = h('thead', null,
        h('tr', null,
          h('th', null, 'ID'),
          h('th', null, 'Task'),
          h('th', null, 'Project'),
          h('th', null, 'Status'),
          h('th', null, 'Created')
        )
      )
      const tbody = h('tbody')

      for (const session of sessions) {
        const row = h('tr')
        row.addEventListener('click', () => {
          window.location.hash = `#/session/${session.sessionId}`
        })
        row.appendChild(h('td', { className: 'session-id' }, session.sessionId.slice(0, 8)))
        row.appendChild(h('td', { className: 'session-task' }, session.task))
        row.appendChild(h('td', { className: 'session-id' }, shortenPath(session.projectDir)))
        row.appendChild(h('td', null, statusBadge(session.status)))
        row.appendChild(h('td', { className: 'session-time' }, formatTime(session.createdAt)))
        tbody.appendChild(row)
      }

      table.appendChild(thead)
      table.appendChild(tbody)
      tableContainer.appendChild(table)
    } catch (err) {
      errorDiv.textContent = String(err)
      errorDiv.style.display = 'block'
    }
  }

  // Modal
  let modal: HTMLElement | null = null

  function showModal() {
    if (modal) return

    const dirInput = h('input', {
      className: 'form-input',
      type: 'text',
      placeholder: '/path/to/project',
    }) as HTMLInputElement

    const taskInput = h('textarea', {
      className: 'form-input',
      placeholder: 'Describe the task for the agent...',
    }) as HTMLTextAreaElement

    const modelInput = h('select', { className: 'form-select' },
      h('optgroup', { label: 'Auto (Recommended)' },
        h('option', { value: 'openrouter/free', selected: 'true' }, 'Auto-route free models (openrouter/free)'),
      ),
      h('optgroup', { label: 'Strong (1M context)' },
        h('option', { value: 'nvidia/nemotron-3-ultra-550b-a55b:free' }, 'Nemotron 3 Ultra 550B'),
        h('option', { value: 'nvidia/nemotron-3-super-120b-a12b:free' }, 'Nemotron 3 Super 120B'),
        h('option', { value: 'minimax/minimax-m3:free' }, 'MiniMax M3 (vision+tools)'),
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
        h('option', { value: 'dots-studio/dots-3-note-preview:free' }, 'Dots 3 Note'),
        h('option', { value: 'liquid/lfm-2.5-2.6b:free' }, 'LFM 2.5 2.6B'),
        h('option', { value: 'thinkingmachines/inkling-small:free' }, 'Inkling Small'),
      ),
    ) as HTMLSelectElement

    const createBtn = h('button', { className: 'btn btn-primary' }, 'Create')
    const cancelBtn = h('button', { className: 'btn' }, 'Cancel')
    const modalError = h('div', { style: 'color: var(--danger); margin-top: 8px; display: none;' })

    createBtn.addEventListener('click', async () => {
      const dir = dirInput.value.trim()
      const task = taskInput.value.trim()
      if (!dir || !task) return

      createBtn.textContent = 'Creating...'
      createBtn.setAttribute('disabled', 'true')
      modalError.style.display = 'none'

      try {
        const result = await client.call('session.create', {
          projectDir: dir,
          task,
          model: modelInput.value,
          permissions: {},
        }) as { sessionId: string }

        hideModal()
        window.location.hash = `#/session/${result.sessionId}`
      } catch (err) {
        modalError.textContent = String(err)
        modalError.style.display = 'block'
        createBtn.textContent = 'Create'
        createBtn.removeAttribute('disabled')
      }
    })

    cancelBtn.addEventListener('click', hideModal)

    modal = h('div', { className: 'modal-overlay' },
      h('div', { className: 'modal' },
        h('div', { className: 'modal-header' },
          h('h3', { className: 'modal-title' }, 'New Session'),
          h('button', { className: 'modal-close', onClick: hideModal }, '\u00D7')
        ),
        h('div', { className: 'form-group' },
          h('label', { className: 'form-label' }, 'Project Directory'),
          dirInput
        ),
        h('div', { className: 'form-group' },
          h('label', { className: 'form-label' }, 'Task'),
          taskInput
        ),
        h('div', { className: 'form-group' },
          h('label', { className: 'form-label' }, 'Model'),
          modelInput
        ),
        modalError,
        h('div', { className: 'modal-actions' }, cancelBtn, createBtn)
      )
    )

    document.body.appendChild(modal)
  }

  function hideModal() {
    if (modal) {
      modal.remove()
      modal = null
    }
  }

  // Disable until WS connected — RpcClient now queues, but UX should block early clicks
  if (client.state !== 'connected') {
    newBtn.setAttribute('disabled', 'true')
    ;(newBtn as HTMLButtonElement).title = 'Connecting to server...'
  }
  client.onStateChange((state) => {
    if (state === 'connected') {
      newBtn.removeAttribute('disabled')
      ;(newBtn as HTMLButtonElement).title = ''
    } else {
      newBtn.setAttribute('disabled', 'true')
      ;(newBtn as HTMLButtonElement).title = 'Connecting to server...'
    }
  })

  newBtn.addEventListener('click', showModal)

  container.appendChild(
    h('div', { style: 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;' },
      h('h2', { className: 'card-title' }, 'Sessions'),
      newBtn
    )
  )
  container.appendChild(errorDiv)
  container.appendChild(tableContainer)

  loadSessions()

  return container
}

function shortenPath(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 2) return path
  return `.../${parts.slice(-2).join('/')}`
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
