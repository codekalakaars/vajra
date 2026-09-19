// Summary index types and pure functions.
//
// These are shared between CLI and server. The async I/O layer
// (buildSummaryIndex) stays in each consumer.

export interface SummaryEntry {
  path: string
  lines: number
  preview: string
  imports: string[]
  exports: string[]
  importCount: number
  exportCount: number
}

export const SYMBOL_PATTERNS = [
  /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g,
  /\bexport\s+\{([^}]+)\}/g,
]

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build',
  '.next', '.turbo', '.cache', '__pycache__',
])

export const SKIP_EXTENSIONS = new Set([
  '.json', '.lock', '.map', '.min.js', '.min.css',
  '.d.ts', '.svg', '.png', '.jpg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
])

export const MAX_FILE_BYTES = 512 * 1024 // 512KB

export function extractSymbols(content: string): string[] {
  const symbols: string[] = []
  for (const pattern of SYMBOL_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    let match
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        // Named export: export { foo, bar }
        const names = match[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
        symbols.push(...names)
      } else {
        symbols.push(match[1])
      }
    }
  }
  return [...new Set(symbols)]
}

export function countImports(content: string): number {
  return (content.match(/^import\s/gm) || []).length
}

export function countExports(content: string): number {
  return (content.match(/^export\s/gm) || []).length
}

export function getPreview(content: string, maxLines = 3): string {
  const lines = content.split('\n').slice(0, maxLines)
  return lines.join('\n').slice(0, 200)
}

export function shouldSkipFile(filePath: string): boolean {
  const parts = filePath.split('/')
  // Check directory components
  for (const part of parts.slice(0, -1)) {
    if (SKIP_DIRS.has(part)) return true
  }
  // Check extension
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  if (SKIP_EXTENSIONS.has(ext)) return true
  return false
}

export function formatSummaryIndexHierarchical(summary: SummaryEntry[]): string {
  if (summary.length === 0) return '(no files)'

  // Group by directory
  const byDir = new Map<string, SummaryEntry[]>()
  for (const entry of summary) {
    const parts = entry.path.split('/')
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir)!.push(entry)
  }

  const lines: string[] = []
  for (const [dir, entries] of byDir) {
    if (dir !== '.') lines.push(`${dir}/`)
    for (const entry of entries) {
      const name = entry.path.split('/').pop()!
      const symbols = entry.exports.length > 0 ? ` [${entry.exports.join(', ')}]` : ''
      lines.push(`  ${name} (${entry.lines}L, ${entry.importCount}i, ${entry.exportCount}e)${symbols}`)
    }
  }
  return lines.join('\n')
}

export function searchSummary(summary: SummaryEntry[], query: string, maxResults = 15): string {
  const lower = query.toLowerCase()
  const scored = summary
    .map(entry => {
      let score = 0
      const pathLower = entry.path.toLowerCase()
      if (pathLower.includes(lower)) score += 10
      for (const exp of entry.exports) {
        if (exp.toLowerCase().includes(lower)) score += 5
      }
      for (const imp of entry.imports) {
        if (imp.toLowerCase().includes(lower)) score += 2
      }
      return { entry, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)

  if (scored.length === 0) return 'No matching files found.'

  return scored
    .map(({ entry }) => {
      const symbols = entry.exports.length > 0 ? ` [${entry.exports.join(', ')}]` : ''
      return `${entry.path} (${entry.lines}L)${symbols}`
    })
    .join('\n')
}
