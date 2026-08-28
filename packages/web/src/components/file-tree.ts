// File tree component.

import { h } from '../router.js'

interface FileEntry {
  name: string
  isDir: boolean
  masked: boolean
}

export function fileTree(entries: FileEntry[], onSelect?: (path: string) => void): HTMLElement {
  const container = h('div', { className: 'file-tree' })
  renderLevel(container, entries, '', onSelect)
  return container
}

function renderLevel(
  container: HTMLElement,
  entries: FileEntry[],
  prefix: string,
  onSelect?: (path: string) => void
): void {
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
    const icon = entry.isDir ? '\uD83D\uDCC1' : entry.masked ? '\uD83D\uDD12' : '\uD83D\uDCC4'
    const iconClass = entry.isDir ? 'dir' : entry.masked ? 'masked' : ''

    const item = h(
      'div',
      { className: `file-tree-item ${entry.isDir ? 'is-dir' : ''}` },
      h('span', { className: `file-icon ${iconClass}` }, icon),
      h('span', null, entry.name)
    )

    if (onSelect) {
      item.addEventListener('click', () => onSelect(fullPath))
    }

    container.appendChild(item)
  }
}
