// Sidebar component: togglable list of all existing sessions.

import { h } from '../router.js'
import { statusBadge } from './status-badge.js'
import type { VajraClient } from '../client.js'

interface SidebarSession {
  id: string
  projectDir: string
  task: string
  status: string
  createdAt: number
}

export function initSidebar(client: VajraClient): void {
  const sidebar = document.getElementById('sidebar') as HTMLElement
  const backdrop = document.getElementById('sidebar-backdrop') as HTMLElement
  const toggle = document.getElementById('sidebar-toggle') as HTMLElement
  const newBtn = document.getElementById('sidebar-new') as HTMLElement
  const listEl = document.getElementById('sidebar-list') as HTMLElement

  const collapsed = localStorage.getItem('sidebarCollapsed') === '1'
  if (collapsed) sidebar.classList.add('collapsed')

  function setCollapsed(val: boolean) {
    sidebar.classList.toggle('collapsed', val)
    localStorage.setItem('sidebarCollapsed', val ? '1' : '0')
    backdrop.classList.toggle('visible', !val && window.innerWidth <= 768)
  }

  toggle.addEventListener('click', () => {
    const isCollapsed = sidebar.classList.contains('collapsed')
    setCollapsed(!isCollapsed)
  })

  backdrop.addEventListener('click', () => setCollapsed(true))

  newBtn.addEventListener('click', () => {
    window.location.hash = '#/'
    if (window.innerWidth <= 768) setCollapsed(true)
  })

  // Disable new button until connected
  if (client.state !== 'connected') {
    newBtn.setAttribute('disabled', 'true')
  }
  client.onStateChange((state) => {
    if (state === 'connected') newBtn.removeAttribute('disabled')
    else newBtn.setAttribute('disabled', 'true')
  })

  async function refresh() {
    try {
      const sessions = (await client.call('session.list', {} as never)) as SidebarSession[]
      render(sessions)
    } catch {
      // ignore until connected
    }
  }

  function render(sessions: SidebarSession[]) {
    listEl.innerHTML = ''
    if (sessions.length === 0) {
      listEl.appendChild(h('div', { className: 'sidebar-empty' }, 'No sessions yet'))
      return
    }
    const activeId = window.location.hash.match(/#\/session\/([^/]+)/)?.[1]
    for (const s of sessions) {
      const deleteBtn = h('button', { className: 'sidebar-delete', title: 'Delete chat' }, '\u00d7')
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm('Delete this chat?')) return
        try {
          await client.call('session.delete', { sessionId: s.id } as never)
          if (window.location.hash === `#/session/${s.id}`) {
            window.location.hash = '#/'
          }
          refresh()
        } catch { /* ignore */ }
      })

      const item = h(
        'div',
        { className: `sidebar-item ${s.id === activeId ? 'active' : ''}` },
        h('div', { className: 'sidebar-item-title' }, s.task || '(untitled)'),
        h(
          'div',
          { className: 'sidebar-item-meta' },
          statusBadge(s.status),
          h('span', { className: 'sidebar-item-path' }, s.projectDir.split('/').pop() || s.projectDir)
        ),
        deleteBtn
      )
      item.addEventListener('click', () => {
        window.location.hash = `#/session/${s.id}`
        if (window.innerWidth <= 768) setCollapsed(true)
      })
      listEl.appendChild(item)
    }
  }

  // Poll + push updates
  refresh()
  client.onStateChange((state) => {
    if (state === 'connected') refresh()
  })
  // Light polling every 5s + on hash change
  setInterval(refresh, 5000)
  window.addEventListener('hashchange', () => refresh())
  // Also refresh on any session.* event
  for (const ev of ['session.completed', 'session.failed', 'session.planUpdated', 'session.deleted'] as const) {
    client.on(ev as never, () => refresh())
  }
}
