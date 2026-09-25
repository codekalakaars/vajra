// Shared agent utilities — deduplicated functions used across loop, developer, etc.

import type { SqliteDb } from '../db/client.js'
import type { SummaryEntry } from './summary.js'
import { stmt } from '../db/statements.js'
import { runInTransaction } from '../db/client.js'
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
  stmt(
    db,
    `INSERT INTO messages (session_id, seq, role, content, tool_name, tool_call_id, tool_args, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, seq, role, content, toolName ?? null, toolCallId ?? null, toolCalls ?? null, Date.now())
}

/**
 * Per-project message sequence. Seeded from the database the first time a
 * project is touched, then kept in memory: every append used to run its own
 * `SELECT MAX(seq)` first, which is both a query per message and a race
 * between concurrent workers appending to the same project.
 */
const sequences = new Map<string, number>()

/**
 * Get the next sequence number for a session's messages.
 */
export function nextSeq(db: SqliteDb, projectId: string): number {
  const cached = sequences.get(projectId)
  if (cached !== undefined) {
    sequences.set(projectId, cached + 1)
    return cached
  }

  const row = stmt(db, `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE session_id = ?`)
    .get(projectId) as { next_seq: number }
  sequences.set(projectId, row.next_seq + 1)
  return row.next_seq
}

/** Forget a project's sequence — call when its messages are deleted. */
export function forgetSeq(projectId: string): void {
  sequences.delete(projectId)
}

/**
 * Append a tool result message (role: 'tool') to the session's message log.
 * Tool results are stored as their own rows with a tool_call_id linking them
 * to the parent assistant message's tool call.
 */
export function appendToolResult(
  db: SqliteDb,
  projectId: string,
  seq: number,
  content: string,
  toolCallId: string,
): void {
  stmt(
    db,
    `INSERT INTO messages (session_id, seq, role, content, tool_call_id, created_at)
     VALUES (?, ?, 'tool', ?, ?, ?)`,
  ).run(projectId, seq, content, toolCallId, Date.now())
}

/**
 * Atomically append an assistant message and its tool results in a single
 * transaction. The assistant message gets `seq`, and each tool result gets the
 * next sequential number. This prevents the race condition where two concurrent
 * callers compute the same `nextSeq` value and the second INSERT violates the
 * primary key.
 */
export function appendMessageWithToolResults(
  db: SqliteDb,
  projectId: string,
  content: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: string }>,
  toolResults?: Array<{ toolCallId: string; content: string }>,
): void {
  runInTransaction(db, () => {
    const assistantSeq = nextSeq(db, projectId)
    appendMessage(db, projectId, assistantSeq, 'assistant', content,
      toolCalls ? JSON.stringify(toolCalls) : undefined)

    if (toolResults) {
      for (const result of toolResults) {
        const resultSeq = nextSeq(db, projectId)
        appendToolResult(db, projectId, resultSeq, result.content, result.toolCallId)
      }
    }
  })
}
