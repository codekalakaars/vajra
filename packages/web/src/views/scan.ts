// Project scan view.

import { h } from '../router.js'
import { fileTree } from '../components/file-tree.js'
import type { VajraClient } from '../client.js'

interface FileEntry {
  name: string
  isDir: boolean
  masked: boolean
}

export function scanView(client: VajraClient): HTMLElement {
  const container = h('div')

  const input = h('input', {
    className: 'form-input',
    type: 'text',
    placeholder: '/path/to/project',
  }) as HTMLInputElement

  const scanBtn = h('button', { className: 'btn btn-primary' }, 'Scan')
  const errorDiv = h('div', { className: 'error', style: 'color: var(--danger); margin-top: 8px; display: none;' })
  const treeContainer = h('div', { style: 'margin-top: 16px;' })

  scanBtn.addEventListener('click', async () => {
    const dir = input.value.trim()
    if (!dir) return

    scanBtn.textContent = 'Scanning...'
    scanBtn.setAttribute('disabled', 'true')
    errorDiv.style.display = 'none'
    treeContainer.innerHTML = ''

    try {
      const result = await client.call('project.scan', { projectDir: dir }) as FileEntry[]
      treeContainer.appendChild(fileTree(result, (path) => {
        window.location.hash = `#/permissions?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`
      }))
    } catch (err) {
      errorDiv.textContent = String(err)
      errorDiv.style.display = 'block'
    } finally {
      scanBtn.textContent = 'Scan'
      scanBtn.removeAttribute('disabled')
    }
  })

  container.appendChild(h('h2', { className: 'card-title' }, 'Scan Project'))
  container.appendChild(h('p', { style: 'color: var(--text-secondary); margin-bottom: 16px;' }, 'Enter a directory path to scan its file structure.'))
  container.appendChild(
    h('div', { className: 'card' },
      h('div', { style: 'display: flex; gap: 8px;' }, input, scanBtn),
      errorDiv
    )
  )
  container.appendChild(treeContainer)

  return container
}
