// Permission toggle row.

import { h } from '../router.js'

export interface Permissions {
  read: boolean
  write: boolean
  edit: boolean
  delete: boolean
}

type PermKey = keyof Permissions

export function permissionRow(
  path: string,
  perms: Permissions,
  onChange: (path: string, key: PermKey, value: boolean) => void
): HTMLElement {
  const row = h('div', { className: 'perm-row' })

  row.appendChild(h('span', { className: 'perm-path', title: path }, path))

  for (const key of ['read', 'write', 'edit', 'delete'] as PermKey[]) {
    const toggle = h('div', { className: 'perm-toggle' })
    const btn = createToggle(perms[key])
    btn.addEventListener('click', () => {
      const newVal = !perms[key]
      perms[key] = newVal
      btn.className = `toggle ${newVal ? 'on' : ''}`
      onChange(path, key, newVal)
    })
    toggle.appendChild(btn)
    row.appendChild(toggle)
  }

  return row
}

function createToggle(on: boolean): HTMLElement {
  const el = h('div', { className: `toggle ${on ? 'on' : ''}` })
  el.setAttribute('role', 'switch')
  el.setAttribute('aria-checked', String(on))
  el.tabIndex = 0
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      el.click()
    }
  })
  return el
}

export function permissionHeader(): HTMLElement {
  return h(
    'div',
    { className: 'perm-row perm-header' },
    h('span', null, 'Path'),
    h('span', null, 'Read'),
    h('span', null, 'Write'),
    h('span', null, 'Edit'),
    h('span', null, 'Delete')
  )
}
