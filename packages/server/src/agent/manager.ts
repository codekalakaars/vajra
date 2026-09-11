// Manager Agent — conversational planning.
//
// The manager runs in the main server process and makes LLM calls to
// understand the user's task through conversation. When it has enough
// context, it calls the `propose_plan` tool, which is intercepted here
// (never dispatched to the sandboxed worker) and returned as a
// ManagerPlan for the user to review.
//
// File tools (read_file, list_files, search_files) are dispatched to the
// sandboxed worker via the LaunchHandle, same as the single-agent loop.

import type { SqliteDb } from '../db/client.js'
import type { PushEvents, LaunchHandle } from '../session/manager.js'
import type { ManagerPlan, PlannedTask, ToolName } from '@codekalakaars/protocol'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'
import { getManagerToolSpecs, parseToolCall } from './tools.js'
import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, formatSummaryIndex, type SummaryEntry } from './summary.js'

const FREE_TOOLS = new Set(['search_files'])

function buildManagerConversationPrompt(
  projectDir: string,
  tree: string,
  summary: string,
): string {
  return [
    'You are the Manager — a software engineering planning agent.',
    '',
    'Your job is to:',
    '1. Understand the user\'s task through conversation',
    '2. Ask clarifying questions about scope, constraints, and preferences',
    '3. Explore the codebase using your tools when needed',
    '4. When you have enough context, produce a structured plan using propose_plan',
    '',
    'You have access to these tools:',
    '- search_files(query): search the summary index to find relevant files (FREE)',
    '- read_file(path): read a file to understand the codebase',
    '- list_files(path): list directory contents',
    '- propose_plan(tasks, summary): propose a structured plan when ready',
    '',
    'IMPORTANT RULES:',
    '- Do NOT call propose_plan on the first message — gather context first',
    '- Ask 2-4 clarifying questions before planning',
    '- Only read files you need to understand the task',
    '- When calling propose_plan, each task needs a title, description, files, validation command, dependencies, and type',
    '- Tasks should be independent where possible; specify dependencies explicitly',
    '- Each task needs a validation command that actually tests the change',
    '- Aim for 2-8 tasks; keep related work together',
    '',
    'Project directory: ' + projectDir,
    '',
    'Project structure:',
    tree,
    '',
    'File summaries (path [lines, imports, exports]: exported symbols):',
    summary,
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

function parseProposePlanArgs(raw: unknown): ManagerPlan {
  const args = raw as {
    tasks: Array<{
      title: string
      description: string
      files: string[]
      validation: string
      dependsOn: string[]
      type: string
    }>
    summary: string
  }

  const tasks: PlannedTask[] = args.tasks.map((t, i) => ({
    id: `task-${i + 1}`,
    title: t.title,
    description: t.description,
    files: t.files,
    validation: t.validation,
    dependsOn: t.dependsOn,
    type: (['create', 'modify', 'delete', 'refactor'].includes(t.type) ? t.type : 'modify') as PlannedTask['type'],
  }))

  // Validate dependency references exist
  const taskIds = new Set(tasks.map((t) => t.id))
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter((dep) => taskIds.has(dep))
  }

  // Compute independent groups from dependency graph
  const independentGroups: string[][] = []
  const assigned = new Set<string>()
  for (const task of tasks) {
    if (assigned.has(task.id)) continue
    const group = [task.id]
    assigned.add(task.id)
    // Find tasks with no deps on unassigned tasks
    for (const other of tasks) {
      if (assigned.has(other.id)) continue
      const depsUnassigned = other.dependsOn.some(dep => !assigned.has(dep))
      if (!depsUnassigned) {
        group.push(other.id)
        assigned.add(other.id)
      }
    }
    independentGroups.push(group)
  }

  return {
    tasks,
    independentGroups,
    estimatedWorkers: Math.max(1, ...independentGroups.map((g) => g.length)),
  }
}

function appendMessage(
  db: SqliteDb,
  sessionId: string,
  seq: number,
  role: string,
  content: string | null,
): void {
  db.prepare(
    `INSERT INTO messages (session_id, seq, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, seq, role, content, Date.now())
}

function nextSeq(db: SqliteDb, sessionId: string): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE session_id = ?`)
    .get(sessionId) as { next_seq: number }
  return row.next_seq
}

// ---- Public API ----

export interface ManagerTurnInput {
  sessionId: string
  projectDir: string
  userMessage: string
  model: string
  apiKey: string
  events: PushEvents
  db: SqliteDb
  handle: LaunchHandle
  /** Accumulated conversation history. Mutated in place. */
  messages: OpenRouterMessage[]
  /** Summary index for in-memory search. Built on first turn. */
  summaryIndex: SummaryEntry[]
}

export type ManagerTurnResult =
  | { type: 'response'; response: string }
  | { type: 'plan'; plan: ManagerPlan }

/**
 * Run one turn of the Manager's conversation.
 *
 * On the first call, builds the system prompt with project context.
 * Subsequent calls reuse the existing conversation history.
 *
 * Returns either a text response (Manager is still gathering context) or
 * a ManagerPlan (Manager called propose_plan).
 */
export async function managerConversationTurn(
  input: ManagerTurnInput,
): Promise<ManagerTurnResult> {
  const { sessionId, projectDir, userMessage, model, apiKey, events, db, handle, messages, summaryIndex } = input

  // First turn: build system prompt and project context
  if (messages.length === 0) {
    let tree = ''
    try {
      const entries = scanProject(projectDir)
      tree = buildNestedTree(entries)
      // Build summary index if not already provided
      if (summaryIndex.length === 0) {
        const indexed = buildSummaryIndex(projectDir, entries)
        summaryIndex.push(...indexed)
      }
    } catch {
      tree = '(unable to read project tree)'
    }

    const summaryText = formatSummaryIndex(summaryIndex)
    messages.push({
      role: 'system',
      content: buildManagerConversationPrompt(projectDir, tree, summaryText),
    })
  }

  // Persist user message
  const userSeq = nextSeq(db, sessionId)
  appendMessage(db, sessionId, userSeq, 'user', userMessage)

  // Add user message to conversation
  messages.push({ role: 'user', content: userMessage })

  const toolSpecs = getManagerToolSpecs()
  let toolCallCount = 0
  const MAX_TOOL_CALLS = 30

  // Tool-use loop (Manager may call read_file/list_files/search_files before proposing)
  while (toolCallCount < MAX_TOOL_CALLS) {
    const result = await streamChatCompletion(
      { apiKey, model, messages, tools: toolSpecs },
      (text) => events.push('session.assistantDelta', sessionId, { text }),
      (thinking) => events.push('session.thinkingDelta', sessionId, { text: thinking }),
    )

    // No tool calls — text response to user
    if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
      const content = result.message.content ?? ''
      const seq = nextSeq(db, sessionId)
      appendMessage(db, sessionId, seq, 'assistant', content)
      messages.push(result.message)
      return { type: 'response', response: content }
    }

    // Has tool calls — process them
    messages.push(result.message)

    for (const toolCall of result.message.tool_calls) {
      // Intercept propose_plan — never dispatch to worker
      if (toolCall.function.name === 'propose_plan') {
        let parsed: unknown
        try {
          parsed = JSON.parse(toolCall.function.arguments)
        } catch {
          // Bad JSON — tell the LLM and let it retry
          messages.push({
            role: 'tool',
            content: 'Error: propose_plan arguments were not valid JSON. Please try again.',
            tool_call_id: toolCall.id,
          })
          continue
        }

        const plan = parseProposePlanArgs(parsed)

        // Persist the plan as the final assistant message
        const planSeq = nextSeq(db, sessionId)
        appendMessage(db, sessionId, planSeq, 'assistant', JSON.stringify(plan))

        // Emit plan events
        for (const t of plan.tasks) {
          events.push('session.planTask', sessionId, { sessionId, task: t })
        }

        return { type: 'plan', plan }
      }

      // All other tools: dispatch to sandboxed worker
      const isFree = FREE_TOOLS.has(toolCall.function.name)
      if (!isFree) {
        toolCallCount++
        if (toolCallCount > MAX_TOOL_CALLS) break
      }

      const parsed = parseToolCall(toolCall)
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

      messages.push({
        role: 'tool',
        content: resultContent,
        tool_call_id: toolCall.id,
      })
    }
  }

  // Exceeded tool budget — force a response
  const fallbackContent = 'I have enough context. Let me propose a plan.'
  messages.push({ role: 'assistant', content: fallbackContent })
  return { type: 'response', response: fallbackContent }
}
