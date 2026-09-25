// Summary index I/O layer — pure helpers live in @codekalakaars/vajra-agent-core.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectFileEntry } from '@codekalakaars/vajra-protocol'
import { MAX_SUMMARY_TOTAL_SIZE } from './constants.js'
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
  extractSymbols,
  countImports,
  countExports,
  getPreview,
  formatSummaryIndex,
  formatSummaryIndexHierarchical,
  searchSummary,
  SKIP_DIRS,
  SKIP_EXTENSIONS,
  SKIP_SUFFIXES,
} from '@codekalakaars/vajra-agent-core'

/** Files past this size are not worth summarizing and cost real time to read. */
const MAX_FILE_BYTES = 512 * 1024

/** How many files to read at once. Reading them one at a time made indexing
 * a large project a long serial walk. */
const READ_CONCURRENCY = 16

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
