// Shared agent utilities — deduplicated functions used across loop, manager, etc.

import type { SqliteDb } from '../db/client.js'
import type { SummaryEntry } from './summary.js'
import { MAX_SEARCH_RESULTS } from './constants.js'

/**
 * Search the summary index for files matching the query.
 * Returns a formatted string with matching file entries.
 */
export function searchSummary(summary: SummaryEntry[], query: string): string {
  const terms = query.toLowerCase().split(/[\s,;]+/).filter(t => t.length > 0)
  if (terms.length === 0) return 'No search terms provided.'

  const matches = summary.filter(entry => {
    const text = `${entry.path} ${entry.symbols.join(' ')}`.toLowerCase()
    return terms.every(t => text.includes(t))
  })

  if (matches.length === 0) return 'No matching files found.'

  return matches
    .slice(0, MAX_SEARCH_RESULTS)
    .map(entry => {
      const symbols = entry.symbols.length > 0 ? entry.symbols.join(', ') : '(no symbols)'
      const meta = `${entry.lineCount}L`
      const imports = entry.importCount > 0 ? `, ${entry.importCount} imports` : ''
      const exports = entry.exportCount > 0 ? `, ${entry.exportCount} exports` : ''
      return `${entry.path} [${meta}${imports}${exports}]\n  Symbols: ${symbols}\n  Preview: ${entry.preview}`
    })
    .join('\n\n')
}

/**
 * Append a message to the session's message log.
 */
export function appendMessage(
  db: SqliteDb,
  projectId: string,
  seq: number,
  role: string,
  content: string | null,
  toolCalls?: string,
  toolCallId?: string,
  toolName?: string,
): void {
  db.prepare(
    `INSERT INTO messages (session_id, seq, role, content, tool_name, tool_call_id, tool_args, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, seq, role, content, toolName ?? null, toolCallId ?? null, toolCalls ?? null, Date.now())
}

/**
 * Get the next sequence number for a session's messages.
 */
export function nextSeq(db: SqliteDb, projectId: string): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE session_id = ?`)
    .get(projectId) as { next_seq: number }
  return row.next_seq
}
