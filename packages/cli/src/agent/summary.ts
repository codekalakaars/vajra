// Summary index I/O layer — pure helpers live in @codekalakaars/vajra-agent-core.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectFileEntry } from '@codekalakaars/vajra-protocol'
import {
  shouldSkipFile,
  extractSymbols,
  countImports,
  countExports,
  getPreview,
  type SummaryEntry,
} from '@codekalakaars/vajra-agent-core'

export type { SummaryEntry }
export {
  shouldSkipFile,
  formatSummaryIndexHierarchical,
  searchSummary,
  SKIP_DIRS,
  SKIP_EXTENSIONS,
  SKIP_SUFFIXES,
} from '@codekalakaars/vajra-agent-core'

export function buildSummaryIndex(projectDir: string, entries: ProjectFileEntry[]): SummaryEntry[] {
  const candidates: SummaryEntry[] = []

  for (const entry of entries) {
    if (shouldSkipFile(entry)) continue

    try {
      const fullPath = join(projectDir, entry.path)
      const content = readFileSync(fullPath, 'utf-8')

      const symbols = extractSymbols(content)
      const preview = getPreview(content)
      const lineCount = content.split('\n').length
      const importCount = countImports(content)
      const exportCount = countExports(content)

      candidates.push({ path: entry.path, symbols, preview, lineCount, importCount, exportCount })
    } catch {
      // Skip unreadable files
    }
  }

  // Rank by importance: exports (entry points) > imports (high fan-in) > line count
  candidates.sort((a, b) => {
    if (a.exportCount !== b.exportCount) return b.exportCount - a.exportCount
    if (a.importCount !== b.importCount) return b.importCount - a.importCount
    return b.lineCount - a.lineCount
  })

  // Truncate after ranking
  const summary: SummaryEntry[] = []
  let totalSize = 0
  const MAX_TOTAL = 16000

  for (const entry of candidates) {
    if (totalSize >= MAX_TOTAL) break
    summary.push(entry)
    totalSize += entry.path.length + entry.symbols.join('').length + entry.preview.length + 50
  }

  return summary
}
