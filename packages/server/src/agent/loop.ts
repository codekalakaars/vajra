// Simplified agent loop — single streaming summary call.
//
// The agent reads the project file tree from the system prompt and streams
// a summary directly. No plan phase, no execute phase, no tool dispatch.

import type { SqliteDb } from '../db/client.js'
import type { PushEvents } from '../session/manager.js'
import type { PermissionsConfig } from '@vajra/protocol'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'
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
  events: PushEvents
  db: SqliteDb
}

export interface AgentLoopResult {
  summary: string
}

/** Build system prompt with file tree and task. */
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
    'Provide a thorough response based on the project files.',
  ].join('\n')
}

/** Append a message to the messages table. */
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

/** Get the next sequence number for a session's messages. */
function nextSeq(db: SqliteDb, sessionId: string): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE session_id = ?`)
    .get(sessionId) as { next_seq: number }
  return row.next_seq
}

/**
 * Agent loop — single streaming summary call.
 * Builds a system prompt with the project file tree and task, then streams
 * the LLM response directly. Emits thinking and text deltas via push events.
 */
export async function agentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { session, apiKey, events, db } = input

  const systemPrompt = buildSystemPrompt(session.projectDir, session.task)
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: session.task },
  ]

  // Persist the user message so attach() can rebuild the full conversation
  const userSeq = nextSeq(db, session.id)
  appendMessage(db, session.id, userSeq, 'user', session.task)

  const result = await streamChatCompletion(
    {
      apiKey,
      model: session.model,
      messages,
    },
    (text) => {
      events.push('session.assistantDelta', session.id, { text })
    },
    (thinking) => {
      events.push('session.thinkingDelta', session.id, { text: thinking })
    },
  )

  const content = result.message.content ?? ''
  const seq = nextSeq(db, session.id)
  appendMessage(db, session.id, seq, 'assistant', content)

  return { summary: content }
}
