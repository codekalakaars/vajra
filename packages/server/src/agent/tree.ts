import type { ProjectFileEntry } from '@vajra/protocol'

const MAX_DEPTH = 3

interface TreeNode {
  name: string
  isDir: boolean
  children: Map<string, TreeNode>
}

function buildTree(entries: ProjectFileEntry[]): TreeNode {
  const root: TreeNode = { name: '', isDir: true, children: new Map() }

  for (const entry of entries) {
    const parts = entry.path.split('/')
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      const isDir = isLast ? entry.isDir : true

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, isDir, children: new Map() })
      }
      current = current.children.get(part)!
      if (!isDir) break
    }
  }

  return root
}

function renderNode(node: TreeNode, depth: number, prefix: string, lines: string[]): void {
  if (depth > MAX_DEPTH) return

  const sorted = [...node.children.entries()].sort(([a, aNode], [b, bNode]) => {
    if (aNode.isDir !== bNode.isDir) return aNode.isDir ? -1 : 1
    return a.localeCompare(b)
  })

  for (let i = 0; i < sorted.length; i++) {
    const [name, child] = sorted[i]
    const isLast = i === sorted.length - 1
    const connector = isLast ? '└─ ' : '├─ '
    const childPrefix = isLast ? '   ' : '│  '

    if (child.isDir) {
      lines.push(`${prefix}${connector}${name}/`)
      if (depth < MAX_DEPTH) {
        renderNode(child, depth + 1, prefix + childPrefix, lines)
      } else {
        lines.push(`${prefix}${childPrefix}...`)
      }
    } else {
      lines.push(`${prefix}${connector}${name}`)
    }
  }
}

export function buildNestedTree(entries: ProjectFileEntry[]): string {
  if (entries.length === 0) return '(empty project)'

  const tree = buildTree(entries)
  const lines: string[] = []

  renderNode(tree, 0, '', lines)

  return lines.join('\n')
}
