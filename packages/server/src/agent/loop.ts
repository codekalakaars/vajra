// Agent loop — tool-use orchestration with summary index.
//
// Builds a nested file tree + summary index in the system prompt, gives the
// LLM tools to search/read files, and dispatches tool calls to the sandboxed
// worker. Streams text and thinking deltas via push events.

import type { SqliteDb } from '../db/client.js'
import type { PushEvents, LaunchHandle } from '../session/manager.js'
import type { PermissionsConfig, ToolName } from '@vajra/protocol'
import { getToolSpecs, parseToolCall } from './tools.js'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'
import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, formatSummaryIndex, type SummaryEntry } from './summary.js'

const MAX_TOOL_CALLS = 50

export interface AgentLoopInput {
  session: {
    id: string
    projectDir: string
    task: string
    model: string
  }
  apiKey: string
  handle: LaunchHandle
  permissions: PermissionsConfig
  events: PushEvents
  db: SqliteDb
}

export interface AgentLoopResult {
  summary: string
  toolCallCount: number
}

function buildSystemPrompt(
  projectDir: string,
  task: string,
  tree: string,
  summary: string,
): string {
  return [
    'You are a software engineering agent working inside a project directory.',
    '',
    'Project structure:',
    tree,
    '',
    'File summaries (path [lines, imports, exports]: exported symbols):',
    summary,
    '',
    'You have access to these tools:',
    '- search_files(query): search the summary index to find relevant files by name or symbol',
    '- read_file(path): read the full contents of a file',
    '- list_files(path): list directory contents',
    '',
    'IMPORTANT: The summary above contains file paths, line counts, and symbols for every indexed file.',
    'Use search_files to find relevant files FIRST. Only call read_file on files you need to inspect in detail.',
    'Do NOT read every file — the summary already tells you what each file contains.',
    'When you have enough information, stop calling tools and provide your response.',
    '',
    `Your task: ${task}`,
  ].join('\n')
}

function searchSummary(summary: SummaryEntry[], query: string): string {
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

function appendMessage(
  db: SqliteDb,
  sessionId: string,
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
  ).run(sessionId, seq, role, content, toolName ?? null, toolCallId ?? null, toolCalls ?? null, Date.now())
}

function nextSeq(db: SqliteDb, sessionId: string): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE session_id = ?`)
    .get(sessionId) as { next_seq: number }
  return row.next_seq
}

/**
 * Agent loop — tool-use orchestration.
 * Builds a system prompt with nested file tree and summary index, gives the
 * LLM tools to search and read files, and handles tool calls in a loop.
 */
export async function agentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { session, apiKey, handle, events, db } = input

  // Build project context
  let tree: string
  let summaryIndex: SummaryEntry[]
  try {
    const entries = scanProject(session.projectDir)
    tree = buildNestedTree(entries)
    summaryIndex = buildSummaryIndex(session.projectDir, entries)
  } catch {
    tree = '(unable to read project tree)'
    summaryIndex = []
  }

  const summaryText = formatSummaryIndex(summaryIndex)
  const systemPrompt = buildSystemPrompt(session.projectDir, session.task, tree, summaryText)

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: session.task },
  ]

  // Persist the user message
  const userSeq = nextSeq(db, session.id)
  appendMessage(db, session.id, userSeq, 'user', session.task)

  const toolSpecs = getToolSpecs()
  let toolCallCount = 0

  // Tool-use loop
  while (toolCallCount < MAX_TOOL_CALLS) {
    const result = await streamChatCompletion(
      {
        apiKey,
        model: session.model,
        messages,
        tools: toolSpecs,
      },
      (text) => {
        events.push('session.assistantDelta', session.id, { text })
      },
      (thinking) => {
        events.push('session.thinkingDelta', session.id, { text: thinking })
      },
    )

    // If no tool calls, we're done
    if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
      const content = result.message.content ?? ''
      const seq = nextSeq(db, session.id)
      appendMessage(db, session.id, seq, 'assistant', content)
      return { summary: content, toolCallCount }
    }

    // Append assistant message with tool calls to conversation
    messages.push(result.message)

    // Persist assistant message
    const assistantSeq = nextSeq(db, session.id)
    appendMessage(
      db,
      session.id,
      assistantSeq,
      'assistant',
      result.message.content ?? '',
      JSON.stringify(result.message.tool_calls),
    )

    // Process each tool call
    for (const toolCall of result.message.tool_calls) {
      toolCallCount++
      if (toolCallCount > MAX_TOOL_CALLS) break

      const parsed = parseToolCall(toolCall)
      events.push('session.toolCall', session.id, {
        callId: toolCall.id,
        tool: toolCall.function.name,
        args: parsed.ok ? parsed.call.args : {},
      })

      let resultContent: string

      if (!parsed.ok) {
        resultContent = `Error: ${parsed.error}`
      } else if (parsed.call.tool === ('search_files' as ToolName)) {
        // Handle search_files in main process (in-memory index)
        const args = parsed.call.args as { query: string }
        resultContent = searchSummary(summaryIndex, args.query)
      } else {
        // Dispatch read_file / list_files to sandboxed worker
        try {
          const result = await handle.callTool(parsed.call.tool, parsed.call.args)
          resultContent = typeof result === 'string' ? result : JSON.stringify(result)
        } catch (e) {
          resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
        }
      }

      events.push('session.toolResult', session.id, {
        callId: toolCall.id,
        tool: toolCall.function.name,
        ok: !resultContent.startsWith('Error:'),
        result: resultContent,
      })

      // Append tool result to messages
      messages.push({
        role: 'tool',
        content: resultContent,
        tool_call_id: toolCall.id,
      })

      // Persist tool result
      const toolSeq = nextSeq(db, session.id)
      appendMessage(
        db,
        session.id,
        toolSeq,
        'tool',
        resultContent,
        undefined,
        toolCall.id,
        toolCall.function.name,
      )
    }
  }

  // Exceeded max tool calls
  const finalContent = `Exceeded maximum tool calls (${MAX_TOOL_CALLS}). Stopping.`
  events.push('session.assistantDelta', session.id, { text: finalContent })
  return { summary: finalContent, toolCallCount }
}
