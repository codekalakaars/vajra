import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectFileEntry } from '@codekalakaars/vajra-protocol'
import { MAX_SUMMARY_TOTAL_SIZE } from './constants.js'

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '.next', 'dist', 'build', '__pycache__'])
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
  '.map', '.lock', '.min.js', '.min.css', '.wasm', '.exe', '.bin', '.db', '.db-shm', '.db-wal',
])

/** Suffixes that the extension check above cannot see: it only looks at the
 * segment after the last dot, so '.min.js' never matched. */
const SKIP_SUFFIXES = ['.min.js', '.min.css', '.d.ts']

/** Files past this size are not worth summarizing and cost real time to read. */
const MAX_FILE_BYTES = 512 * 1024

/** How many files to read at once. Reading them one at a time made indexing
 * a large project a long serial walk. */
const READ_CONCURRENCY = 16

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

  const path = entry.path.toLowerCase()
  const ext = '.' + path.split('.').pop()
  if (SKIP_EXTENSIONS.has(ext)) return true
  if (SKIP_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true

  // SKIP_DIRS was declared and never consulted, so build output — dist,
  // target, .next — was read and parsed on every index.
  return path.split('/').some((segment) => SKIP_DIRS.has(segment))
}

async function summarizeFile(projectDir: string, entry: ProjectFileEntry): Promise<SummaryEntry | null> {
  try {
    const fullPath = join(projectDir, entry.path)

    const info = await stat(fullPath)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null

    const content = await readFile(fullPath, 'utf-8')
    const symbols = extractSymbols(content)

    return {
      path: entry.path,
      symbols,
      preview: getPreview(content),
      lineCount: content.split('\n').length,
      importCount: countImports(content),
      exportCount: countExports(content),
    }
  } catch {
    // Skip unreadable files
    return null
  }
}

export async function buildSummaryIndex(projectDir: string, entries: ProjectFileEntry[]): Promise<SummaryEntry[]> {
  const candidates = entries.filter((entry) => !shouldSkipFile(entry))
  const summary: SummaryEntry[] = []
  let totalSize = 0

  for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
    if (totalSize >= MAX_SUMMARY_TOTAL_SIZE) break

    const batch = await Promise.all(
      candidates.slice(i, i + READ_CONCURRENCY).map((entry) => summarizeFile(projectDir, entry)),
    )

    for (const entry of batch) {
      if (!entry) continue
      if (totalSize >= MAX_SUMMARY_TOTAL_SIZE) break

      summary.push(entry)
      totalSize += entry.path.length + entry.symbols.join('').length + entry.preview.length + 50
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
