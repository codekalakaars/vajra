// Permissions editor view.

import { h } from '../router.js'
import { permissionRow, permissionHeader, type Permissions } from '../components/permission-toggle.js'
import type { VajraClient } from '../client.js'

export function permissionsView(client: VajraClient, params: Record<string, string>): HTMLElement {
  const container = h('div')
  const dir = params.dir || ''

  const input = h('input', {
    className: 'form-input',
    type: 'text',
    value: dir,
    placeholder: '/path/to/project',
  }) as HTMLInputElement

  const loadBtn = h('button', { className: 'btn' }, 'Load')
  const saveBtn = h('button', { className: 'btn btn-primary' }, 'Save Permissions')
  const errorDiv = h('div', { style: 'color: var(--danger); margin-top: 8px; display: none;' })
  const successDiv = h('div', { style: 'color: var(--success); margin-top: 8px; display: none;' })
  const permContainer = h('div', { style: 'margin-top: 16px;' })

  let currentPerms: Record<string, Permissions> = {}

  loadBtn.addEventListener('click', async () => {
    const d = input.value.trim()
    if (!d) return

    loadBtn.textContent = 'Loading...'
    loadBtn.setAttribute('disabled', 'true')
    errorDiv.style.display = 'none'
    successDiv.style.display = 'none'
    permContainer.innerHTML = ''

    try {
      const result = await client.call('project.loadPermissions', { projectDir: d }) as Record<string, Permissions>
      currentPerms = result

      const header = permissionHeader()
      permContainer.appendChild(header)

      for (const [path, perms] of Object.entries(result)) {
        permContainer.appendChild(
          permissionRow(path, { ...perms }, (p, key, val) => {
            currentPerms[p][key] = val
          })
        )
      }
    } catch (err) {
      errorDiv.textContent = String(err)
      errorDiv.style.display = 'block'
    } finally {
      loadBtn.textContent = 'Load'
      loadBtn.removeAttribute('disabled')
    }
  })

  saveBtn.addEventListener('click', async () => {
    const d = input.value.trim()
    if (!d || Object.keys(currentPerms).length === 0) return

    saveBtn.textContent = 'Saving...'
    saveBtn.setAttribute('disabled', 'true')
    errorDiv.style.display = 'none'
    successDiv.style.display = 'none'

    try {
      await client.call('project.savePermissions', { projectDir: d, permissions: currentPerms })
      successDiv.textContent = 'Permissions saved.'
      successDiv.style.display = 'block'
    } catch (err) {
      errorDiv.textContent = String(err)
      errorDiv.style.display = 'block'
    } finally {
      saveBtn.textContent = 'Save Permissions'
      saveBtn.removeAttribute('disabled')
    }
  })

  // Guard buttons until WS connected
  const updateConn = (state: string) => {
    const disabled = state !== 'connected'
    if (disabled) {
      loadBtn.setAttribute('disabled', 'true')
      saveBtn.setAttribute('disabled', 'true')
      loadBtn.title = saveBtn.title = 'Connecting to server...'
    } else {
      // re-enable; per-action handlers will manage disabled during load/save
      if (loadBtn.textContent === 'Load') loadBtn.removeAttribute('disabled')
      if (saveBtn.textContent === 'Save Permissions') saveBtn.removeAttribute('disabled')
      loadBtn.title = saveBtn.title = ''
    }
  }
  if (client.state !== 'connected') updateConn(client.state)
  client.onStateChange(updateConn)

  container.appendChild(h('h2', { className: 'card-title' }, 'Permissions'))
  container.appendChild(h('p', { style: 'color: var(--text-secondary); margin-bottom: 16px;' }, 'Configure which files the agent can access.'))
  container.appendChild(
    h('div', { className: 'card' },
      h('div', { style: 'display: flex; gap: 8px; margin-bottom: 8px;' }, input, loadBtn),
      saveBtn,
      errorDiv,
      successDiv
    )
  )
  container.appendChild(permContainer)

  // Auto-load if dir param provided
  if (dir) {
    setTimeout(() => loadBtn.click(), 0)
  }

  return container
}
