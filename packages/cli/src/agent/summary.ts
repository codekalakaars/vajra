import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectFileEntry } from '@codekalakaars/vajra-protocol'

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '.next', 'dist', 'build', '__pycache__'])
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
  '.map', '.lock', '.min.js', '.min.css', '.wasm', '.exe', '.bin', '.db', '.db-shm', '.db-wal',
])

const SYMBOL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
  /\b(?:export\s+)?class\s+(\w+)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g,
  /\b(?:export\s+)?(?:type|interface)\s+(\w+)/g,
  /\b(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+(\w+)/g,
  /\b(?:export\s+)?(?:default\s+)?(?:function|class)\s+(\w+)/g,
  /\bmodule\.exports\s*=\s*(\w+)/g,
  /\b(?:pub\s+)?static\s+(\w+)/g,
]

export interface SummaryEntry {
  path: string
  symbols: string[]
  preview: string
  lineCount: number
  importCount: number
  exportCount: number
}

function extractSymbols(content: string): string[] {
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

function countImports(content: string): number {
  const lines = content.split('\n')
  return lines.filter(l => /^\s*import\s/.test(l) || /^\s*from\s+['"].*['"]\s+import/.test(l)).length
}

function countExports(content: string): number {
  return (content.match(/\bexport\b/g) || []).length
}

function getPreview(content: string, maxLines = 3): string {
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  return lines.slice(0, maxLines).join(' ').slice(0, 150)
}

function shouldSkipFile(entry: ProjectFileEntry): boolean {
  if (entry.isDir) return true
  const ext = '.' + entry.path.split('.').pop()?.toLowerCase()
  if (SKIP_EXTENSIONS.has(ext)) return true
  if (entry.path.includes('node_modules/') || entry.path.includes('.git/')) return true
  return false
}

export function buildSummaryIndex(projectDir: string, entries: ProjectFileEntry[]): SummaryEntry[] {
  const summary: SummaryEntry[] = []
  let totalSize = 0
  const MAX_TOTAL = 16000

  for (const entry of entries) {
    if (shouldSkipFile(entry)) continue
    if (totalSize >= MAX_TOTAL) break

    try {
      const fullPath = join(projectDir, entry.path)
      const content = readFileSync(fullPath, 'utf-8')

      const symbols = extractSymbols(content)
      const preview = getPreview(content)
      const lineCount = content.split('\n').length
      const importCount = countImports(content)
      const exportCount = countExports(content)

      summary.push({ path: entry.path, symbols, preview, lineCount, importCount, exportCount })
      totalSize += entry.path.length + symbols.join('').length + preview.length + 50
    } catch {
      // Skip unreadable files
    }
  }

  return summary
}

export function formatSummaryIndex(summary: SummaryEntry[]): string {
  if (summary.length === 0) return '(no files indexed)'

  return summary
    .map(entry => {
      const symbols = entry.symbols.length > 0 ? entry.symbols.join(', ') : '(no symbols)'
      const meta = `${entry.lineCount}L`
      const imports = entry.importCount > 0 ? `, ${entry.importCount} imports` : ''
      const exports = entry.exportCount > 0 ? `, ${entry.exportCount} exports` : ''
      return `${entry.path} [${meta}${imports}${exports}]: ${symbols}`
    })
    .join('\n')
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

  // Group by directory
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

  // Sort directories by number of files (most files first)
  const sortedDirs = [...dirMap.entries()].sort((a, b) => b[1].length - a[1].length)

  for (const [dir, entries] of sortedDirs) {
    if (currentSize >= maxTokens) break

    // Directory header
    const dirHeader = `\n${dir}/ (${entries.length} files)`
    result.push(dirHeader)
    currentSize += dirHeader.length

    // Sort entries by importance (exports > imports > line count)
    const sortedEntries = entries.sort((a, b) => {
      if (a.exportCount !== b.exportCount) return b.exportCount - a.exportCount
      if (a.importCount !== b.importCount) return b.importCount - a.importCount
      return b.lineCount - a.lineCount
    })

    // Add entries with adaptive detail
    for (const entry of sortedEntries) {
      if (currentSize >= maxTokens) break

      const fileName = entry.path.split('/').pop() || entry.path
      const symbols = entry.symbols.length > 0 ? entry.symbols.slice(0, 5).join(', ') : ''

      // Adaptive detail based on importance
      let line: string
      if (entry.exportCount > 3) {
        // High importance: full detail
        line = `  ${fileName} [${entry.lineCount}L, ${entry.exportCount} exports]: ${symbols}`
      } else if (entry.exportCount > 0 || entry.importCount > 2) {
        // Medium importance: partial detail
        line = `  ${fileName} [${entry.lineCount}L]: ${symbols}`
      } else {
        // Low importance: minimal detail
        line = `  ${fileName} (${entry.lineCount}L)`
      }

      result.push(line)
      currentSize += line.length
    }
  }

  return result.join('\n')
}

/**
 * Compress summary based on relevance to a task.
 * Returns only files relevant to the task's file lists.
 */
export function compressSummaryByRelevance(
  summary: SummaryEntry[],
  readFile: string[],
  writeFile: string[],
  maxTokens: number = 2000,
): string {
  if (summary.length === 0) return '(no files indexed)'

  // Score each entry by relevance
  const scored = summary.map(entry => {
    let score = 0

    // Direct file match
    if (readFile.includes(entry.path)) score += 10
    if (writeFile.includes(entry.path)) score += 10

    // Directory match
    const entryDir = entry.path.split('/').slice(0, -1).join('/')
    for (const file of [...readFile, ...writeFile]) {
      const fileDir = file.split('/').slice(0, -1).join('/')
      if (entryDir === fileDir) score += 3
      if (fileDir.startsWith(entryDir)) score += 1
    }

    // Symbol relevance (if any symbols match file names)
    for (const symbol of entry.symbols) {
      for (const file of [...readFile, ...writeFile]) {
        const fileName = file.split('/').pop()?.replace(/\.\w+$/, '') || ''
        if (symbol.toLowerCase().includes(fileName.toLowerCase())) {
          score += 2
        }
      }
    }

    return { entry, score }
  })

  // Sort by relevance score
  const sorted = scored.sort((a, b) => b.score - a.score)

  const result: string[] = []
  let currentSize = 0

  // Always include high-relevance files
  for (const { entry, score } of sorted) {
    if (currentSize >= maxTokens) break

    const symbols = entry.symbols.length > 0 ? entry.symbols.join(', ') : ''
    const prefix = score >= 10 ? '★' : score >= 3 ? '●' : '○'
    const line = `${prefix} ${entry.path} [${entry.lineCount}L]: ${symbols}`

    result.push(line)
    currentSize += line.length
  }

  return result.join('\n')
}

export function searchSummary(summary: SummaryEntry[], query: string): string {
  const terms = query.toLowerCase().split(/[\s,;]+/).filter(t => t.length > 0)
  if (terms.length === 0) return 'No search terms provided.'

  const matches = summary.filter(entry => {
    const text = `${entry.path} ${entry.symbols.join(' ')}`.toLowerCase()
    return terms.every(t => text.includes(t))
  })

  if (matches.length === 0) return 'No matching files found.'

  return matches
    .slice(0, 15)
    .map(entry => {
      const symbols = entry.symbols.length > 0 ? entry.symbols.join(', ') : '(no symbols)'
      const meta = `${entry.lineCount}L`
      const imports = entry.importCount > 0 ? `, ${entry.importCount} imports` : ''
      const exports = entry.exportCount > 0 ? `, ${entry.exportCount} exports` : ''
      return `${entry.path} [${meta}${imports}${exports}]\n  Symbols: ${symbols}\n  Preview: ${entry.preview}`
    })
    .join('\n\n')
}
