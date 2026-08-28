// The plan-then-execute orchestration loop.
//
// Wires the launcher (slice 2) and OpenRouter client (slice 3) together:
// plan a task via the LLM, persist plan steps, then execute each step by
// dispatching tool calls to the sandboxed worker. Emits push events at every
// state transition so the UI can render progress in real time.

import type { SqliteDb } from '../db/client.js'
import type { LaunchHandle } from '../session/manager.js'
import type { PushEvents } from '../session/manager.js'
import type { PermissionsConfig } from '@vajra/protocol'
import { chatCompletion, type OpenRouterMessage } from './openrouter.js'
import { parseToolCall, getToolSpecs } from './tools.js'
import { scanProject } from '../native.js'

export interface AgentLoopInput {
  session: {
    id: string
    projectDir: string
    task: string
    model: string
  }
  apiKey: string
  permissions: PermissionsConfig
  handle: LaunchHandle
  events: PushEvents
  db: SqliteDb
  /** Maximum tool calls before the session is failed. Default 50. */
  maxToolCalls?: number
}

export interface AgentLoopResult {
  summary: string
  toolCallCount: number
}

/** Default system prompt preamble — the file tree and task are appended. */
function buildSystemPrompt(projectDir: string, task: string): string {
  let fileTree: string
  try {
    const entries = scanProject(projectDir)
    fileTree = entries.map((e) => `${e.isDir ? '/' : '  '}${e.path}`).join('\n')
  } catch {
    fileTree = '(unable to read project tree)'
  }

  return [
    'You are a software engineering agent working inside a project directory.',
    '',
    `Project structure:\n${fileTree}`,
    '',
    `Your task: ${task}`,
    '',
    'You have access to tools that operate on files in this project.',
    'Use them to complete the task. When you are done, respond with a summary.',
    'If a tool call fails, the error is shown to you — adjust your approach and try again.',
  ].join('\n')
}

/**
 * Parse numbered plan steps from the model's text response.
 *
 * Matches lines like:
 *   1. Do the thing
 *   2) Do the other thing
 *   3.  Indented step
 *
 * Returns an array of step titles, or a single step with the full text if
 * no numbered list is detected.
 */
export function parsePlanSteps(text: string): string[] {
  const lines = text.split('\n')
  const steps: string[] = []

  for (const line of lines) {
    const match = line.match(/^\s*\d+[.)]\s+(.+)/)
    if (match) {
      steps.push(match[1].trim())
    }
  }

  // If no numbered steps found, treat the whole response as one step
  if (steps.length === 0 && text.trim().length > 0) {
    return [text.trim()]
  }

  return steps
}

/** Insert a single plan step into the DB and push an event. */
function insertPlanStep(
  db: SqliteDb,
  sessionId: string,
  index: number,
  title: string,
  events: PushEvents,
): void {
  db.prepare(
    `INSERT INTO plan_steps (session_id, step_index, title, status) VALUES (?, ?, ?, 'pending')`,
  ).run(sessionId, index, title)

  pushPlanUpdated(db, sessionId, events)
}

/** Read all plan steps and push session.planUpdated. */
function pushPlanUpdated(db: SqliteDb, sessionId: string, events: PushEvents): void {
  const rows = db
    .prepare(`SELECT step_index, title, status FROM plan_steps WHERE session_id = ? ORDER BY step_index`)
    .all(sessionId) as Array<{ step_index: number; title: string; status: string }>

  events.push('session.planUpdated', sessionId, {
    steps: rows.map((r) => ({ index: r.step_index, title: r.title, status: r.status })),
  })
}

/** Set a plan step's status and push session.stepStatus. */
function setStepStatus(
  db: SqliteDb,
  sessionId: string,
  index: number,
  status: string,
  events: PushEvents,
): void {
  db.prepare(`UPDATE plan_steps SET status = ? WHERE session_id = ? AND step_index = ?`)
    .run(status, sessionId, index)

  events.push('session.stepStatus', sessionId, { index, status })
}

/** Append a message to the messages table. */
function appendMessage(
  db: SqliteDb,
  sessionId: string,
  seq: number,
  role: string,
  content: string | null,
  toolName?: string,
  toolCallId?: string,
  toolArgs?: string,
  toolResult?: string,
): void {
  db.prepare(
    `INSERT INTO messages (session_id, seq, role, content, tool_name, tool_call_id, tool_args, tool_result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, seq, role, content, toolName ?? null, toolCallId ?? null, toolArgs ?? null, toolResult ?? null, Date.now())
}

/** Get the next sequence number for a session's messages. */
function nextSeq(db: SqliteDb, sessionId: string): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE session_id = ?`)
    .get(sessionId) as { next_seq: number }
  return row.next_seq
}

/**
 * The main agent loop. Plans a task, then executes each step by dispatching
 * tool calls to the sandboxed worker. Emits push events at every state
 * transition. Persists plan steps and messages to SQLite.
 *
 * This function is the "brain" that wires slices 1-3 together. It holds the
 * API key in the main process — the worker never sees it.
 */
export async function agentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { session, apiKey, handle, events, db } = input
  const maxToolCalls = input.maxToolCalls ?? 50
  const tools = getToolSpecs()

  const systemPrompt = buildSystemPrompt(session.projectDir, session.task)
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
  ]

  let toolCallCount = 0

  // ---- PLAN PHASE ----
  const planResult = await chatCompletion({
    apiKey,
    model: session.model,
    messages: [...messages, { role: 'user', content: `Plan how to accomplish this task: ${session.task}` }],
    tools,
    toolChoice: 'none',
  })

  const planText = planResult.message.content ?? ''
  const stepTitles = parsePlanSteps(planText)

  if (stepTitles.length === 0) {
    throw new Error('Model did not produce any plan steps')
  }

  // Persist plan steps
  for (let i = 0; i < stepTitles.length; i++) {
    insertPlanStep(db, session.id, i, stepTitles[i], events)
  }

  // Persist the plan response
  let seq = nextSeq(db, session.id)
  appendMessage(db, session.id, seq, 'assistant', planText)
  seq++

  // ---- EXECUTE PHASE ----
  for (let stepIdx = 0; stepIdx < stepTitles.length; stepIdx++) {
    setStepStatus(db, session.id, stepIdx, 'active', events)

    // Add a user message instructing this step
    messages.push({
      role: 'user',
      content: `Execute step ${stepIdx + 1}: ${stepTitles[stepIdx]}`,
    })

    // Inner loop: keep calling the model until it produces a text response
    // (no tool calls) for this step.
    let stepComplete = false
    while (!stepComplete) {
      if (toolCallCount >= maxToolCalls) {
        throw new Error(`Max tool calls (${maxToolCalls}) exceeded`)
      }

      const result = await chatCompletion({
        apiKey,
        model: session.model,
        messages,
        tools,
      })

      const assistantMsg = result.message
      messages.push(assistantMsg)

      // Persist assistant message
      seq = nextSeq(db, session.id)
      const assistantContent = assistantMsg.content ?? null
      const toolCallsJson = assistantMsg.tool_calls ? JSON.stringify(assistantMsg.tool_calls) : null
      appendMessage(db, session.id, seq, 'assistant', assistantContent)
      seq++

      // Push text deltas if the model produced content
      if (assistantMsg.content) {
        events.push('session.assistantDelta', session.id, { text: assistantMsg.content })
      }

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        // Dispatch each tool call
        for (const rawCall of assistantMsg.tool_calls) {
          toolCallCount++

          const parsed = parseToolCall(rawCall)

          if (parsed.ok) {
            const { callId, tool, args } = parsed.call

            events.push('session.toolCall', session.id, { callId, tool, args })

            let result: unknown
            let ok = true
            let error: string | undefined

            try {
              result = await handle.callTool(tool, args)
            } catch (e) {
              ok = false
              error = e instanceof Error ? e.message : String(e)
              result = error
            }

            events.push('session.toolResult', session.id, { callId, tool, ok, result, error })

            // Add tool result to conversation so the model sees it
            messages.push({
              role: 'tool',
              tool_call_id: callId,
              name: tool,
              content: JSON.stringify(result),
            })

            // Persist tool result
            seq = nextSeq(db, session.id)
            appendMessage(
              db,
              session.id,
              seq,
              'tool',
              JSON.stringify(result),
              tool,
              callId,
              JSON.stringify(args),
              JSON.stringify(result),
            )
            seq++
          } else {
            // Pre-validation failed — send error back to model without IPC
            events.push('session.toolResult', session.id, {
              callId: parsed.callId,
              tool: rawCall.function.name,
              ok: false,
              error: parsed.error,
            })

            messages.push({
              role: 'tool',
              tool_call_id: parsed.callId,
              name: rawCall.function.name,
              content: JSON.stringify({ error: parsed.error }),
            })

            seq = nextSeq(db, session.id)
            appendMessage(
              db,
              session.id,
              seq,
              'tool',
              JSON.stringify({ error: parsed.error }),
              rawCall.function.name,
              parsed.callId,
              rawCall.function.arguments,
              JSON.stringify({ error: parsed.error }),
            )
            seq++
          }
        }
      } else {
        // No tool calls — the model produced a text response. Step complete.
        stepComplete = true
        setStepStatus(db, session.id, stepIdx, 'done', events)
      }
    }
  }

  // ---- COMPLETION ----
  const lastAssistant = messages
    .filter((m): m is OpenRouterMessage & { role: 'assistant' } => m.role === 'assistant')
    .pop()

  const summary = lastAssistant?.content ?? 'Task completed'

  return { summary, toolCallCount }
}
