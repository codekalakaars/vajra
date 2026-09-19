// Build a nested tree string from a list of file paths.
//
// Produces output like:
//   src/
//     api.ts
//     utils.ts
//   README.md

export function buildNestedTree(files: string[]): string {
  const root: Record<string, unknown> = {}

  for (const file of files) {
    const parts = file.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === parts.length - 1) {
        current[part] = null // leaf = file
      } else {
        if (!current[part]) current[part] = {}
        current[part] = current[part] as Record<string, unknown>
        current = current[part] as Record<string, unknown>
      }
    }
  }

  function render(node: Record<string, unknown>, prefix: string): string {
    const lines: string[] = []
    const entries = Object.keys(node).sort()
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i]
      const isLast = i === entries.length - 1
      const connector = isLast ? '└── ' : '├── '
      if (node[key] === null) {
        // File
        lines.push(prefix + connector + key)
      } else {
        // Directory
        lines.push(prefix + connector + key + '/')
        const childPrefix = prefix + (isLast ? '    ' : '│   ')
        lines.push(render(node[key] as Record<string, unknown>, childPrefix))
      }
    }
    return lines.join('\n')
  }

  return render(root, '')
}
