// Summary index types and pure functions.
//
// Shared between CLI and server. The I/O layer (buildSummaryIndex) stays in
// each consumer — this package is zero-I/O.

import type { ProjectFileEntry } from '@codekalakaars/vajra-protocol'

export interface SummaryEntry {
  path: string
  symbols: string[]
  preview: string
  lineCount: number
  importCount: number
  exportCount: number
}

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', '.next', 'dist', 'build', '__pycache__',
  '.turbo', '.cache',
])

export const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
  '.map', '.lock', '.wasm', '.exe', '.bin', '.db', '.db-shm', '.db-wal',
])

/** Suffixes the extension check cannot see: it only looks after the last dot. */
export const SKIP_SUFFIXES = ['.min.js', '.min.css']

const SYMBOL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
  /\b(?:export\s+)?class\s+(\w+)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g,
  /\b(?:export\s+)?(?:type|interface)\s+(\w+)\s+/g,
  /\b(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+(\w+)/g,
  /\b(?:export\s+)?(?:default\s+)?(?:function|class)\s+(\w+)/g,
  /\bmodule\.exports\s*=\s*(\w+)/g,
  /\b(?:pub\s+)?static\s+(\w+)/g,
]

export function extractSymbols(content: string): string[] {
  const symbols = new Set<string>()
  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      if (match[1] && match[1] !== 'if' && match[1] !== 'for' && match[1] !== 'while') {
        symbols.add(match[1])
      }
    }
  }
  return [...symbols].slice(0, 15)
}

export function countImports(content: string): number {
  const lines = content.split('\n')
  return lines.filter(l => /^\s*import\s/.test(l) || /^\s*from\s+['"].*['"]\s+import/.test(l)).length
}

export function countExports(content: string): number {
  return (content.match(/\bexport\b/g) || []).length
}

export function getPreview(content: string, maxLines = 3): string {
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  return lines.slice(0, maxLines).join(' ').slice(0, 150)
}

export function shouldSkipFile(entry: ProjectFileEntry): boolean {
  if (entry.isDir) return true
  if (entry.isMasked) return true

  const path = entry.path.toLowerCase()
  const ext = '.' + path.split('.').pop()
  if (SKIP_EXTENSIONS.has(ext)) return true
  if (SKIP_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true

  return path.split('/').some((segment) => SKIP_DIRS.has(segment))
}

/**
 * Format summary index with hierarchical compression.
 * Groups files by directory and provides different levels of detail.
 */
export function formatSummaryIndexHierarchical(
  summary: SummaryEntry[],
  maxTokens: number = 4000,
): string {
  if (summary.length === 0) return '(no files indexed)'

  const dirMap = new Map<string, SummaryEntry[]>()
  for (const entry of summary) {
    const parts = entry.path.split('/')
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
    const entries = dirMap.get(dir) || []
    entries.push(entry)
    dirMap.set(dir, entries)
  }

  const result: string[] = []
  let currentSize = 0

  const sortedDirs = [...dirMap.entries()].sort((a, b) => b[1].length - a[1].length)

  for (const [dir, entries] of sortedDirs) {
    if (currentSize >= maxTokens) break

    const dirHeader = `\n${dir}/ (${entries.length} files)`
    result.push(dirHeader)
    currentSize += dirHeader.length

    const sortedEntries = entries.sort((a, b) => {
      if (a.exportCount !== b.exportCount) return b.exportCount - a.exportCount
      if (a.importCount !== b.importCount) return b.importCount - a.importCount
      return b.lineCount - a.lineCount
    })

    for (const entry of sortedEntries) {
      if (currentSize >= maxTokens) break

      const fileName = entry.path.split('/').pop() || entry.path
      const symbols = entry.symbols.length > 0 ? entry.symbols.slice(0, 5).join(', ') : ''

      let line: string
      if (entry.exportCount > 3) {
        line = `  ${fileName} [${entry.lineCount}L, ${entry.exportCount} exports]: ${symbols}`
      } else if (entry.exportCount > 0 || entry.importCount > 2) {
        line = `  ${fileName} [${entry.lineCount}L]: ${symbols}`
      } else {
        line = `  ${fileName} (${entry.lineCount}L)`
      }

      result.push(line)
      currentSize += line.length
    }
  }

  return result.join('\n')
}

export function searchSummary(summary: SummaryEntry[], query: string): string {
  const terms = query.toLowerCase().split(/[\s,;]+/).filter(t => t.length > 0)
  if (terms.length === 0) return 'No search terms provided.'

  const scored = summary
    .map(entry => {
      const text = `${entry.path} ${entry.symbols.join(' ')} ${entry.preview}`.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (text.includes(t)) score++
      }
      return { entry, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.exportCount - a.entry.exportCount)
    .slice(0, 15)

  if (scored.length === 0) return 'No matching files found.'

  return scored
    .map(({ entry }) => {
      const symbols = entry.symbols.length > 0 ? entry.symbols.join(', ') : '(no symbols)'
      const meta = `${entry.lineCount}L`
      const imports = entry.importCount > 0 ? `, ${entry.importCount} imports` : ''
      const exports = entry.exportCount > 0 ? `, ${entry.exportCount} exports` : ''
      return `${entry.path} [${meta}${imports}${exports}]\n  Symbols: ${symbols}\n  Preview: ${entry.preview}`
    })
    .join('\n\n')
}
