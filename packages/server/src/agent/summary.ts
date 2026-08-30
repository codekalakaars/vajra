import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectFileEntry } from '@vajra/protocol'

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
