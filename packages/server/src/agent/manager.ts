// Manager Agent — decomposes the user's task into a structured plan.
//
// The manager does NOT run inside a sandboxed worker. It runs in the main
// server process and makes LLM calls to analyze the project and decompose
// the task. The analysis is done by reading files through the existing
// agent loop infrastructure, and the decomposition is a single LLM call
// with a structured output prompt.

import type { SqliteDb } from '../db/client.js'
import type { PushEvents } from '../session/manager.js'
import type { ManagerPlan, PlannedTask, PermissionsConfig } from '@vajra/protocol'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'
import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, formatSummaryIndex, type SummaryEntry } from './summary.js'

export interface ManagerInput {
  sessionId: string
  projectDir: string
  task: string
  model: string
  apiKey: string
  events: PushEvents
  db: SqliteDb
}

function buildManagerPrompt(
  projectDir: string,
  task: string,
  tree: string,
  summary: string,
): string {
  return [
    'You are a project manager agent. Your job is to decompose a user\'s task into actionable subtasks.',
    '',
    '## Project context',
    '',
    'Project directory: ' + projectDir,
    '',
    'Project structure:',
    tree,
    '',
    'File summaries (path [lines, imports, exports]: exported symbols):',
    summary,
    '',
    '## Task',
    '',
    task,
    '',
    '## Instructions',
    '',
    'Analyze the project and the task. Decompose it into independent subtasks where possible.',
    'For each subtask, provide:',
    '- A short title',
    '- A description of what needs to be done',
    '- Which files the task touches (project-relative paths)',
    '- A validation command to verify completion (e.g., "cargo test -p crate", "npm test -- pattern", "cargo clippy --all-targets")',
    '- Which other task IDs this depends on (empty array if independent)',
    '- Task type: "create" (new file), "modify" (edit existing), "delete" (remove), or "refactor" (restructure)',
    '',
    'Group independent tasks that can run in parallel.',
    '',
    '## Output format',
    '',
    'Respond with ONLY a JSON object matching this exact schema (no markdown, no explanation):',
    '',
    '{',
    '  "tasks": [',
    '    {',
    '      "id": "task-1",',
    '      "title": "Short title",',
    '      "description": "What to do",',
    '      "files": ["src/file.ts"],',
    '      "validation": "npm test",',
    '      "depends_on": [],',
    '      "type": "create"',
    '    }',
    '  ],',
    '  "independent_groups": [["task-1", "task-2"], ["task-3"]]',
    '}',
    '',
    'Rules:',
    '- Task IDs must be unique, starting from "task-1"',
    '- "independent_groups" lists groups of tasks that can run in parallel',
    '- Each group contains task IDs with no dependencies between them',
    '- Aim for 2-8 tasks; keep related work together',
    '- The validation command should actually test the changes made',
    '- Every file path must be a valid project-relative path from the structure above',
    '',
    `Your task: ${task}`,
  ].join('\n')
}

interface RawPlanResponse {
  tasks: Array<{
    id: string
    title: string
    description: string
    files: string[]
    validation: string
    depends_on: string[]
    type: string
  }>
  independent_groups: string[][]
}

function parsePlan(raw: RawPlanResponse, projectDir: string): ManagerPlan {
  const tasks: PlannedTask[] = raw.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    files: t.files,
    validation: t.validation,
    dependsOn: t.depends_on,
    type: (['create', 'modify', 'delete', 'refactor'].includes(t.type) ? t.type : 'modify') as PlannedTask['type'],
  }))

  // Validate dependency references exist
  const taskIds = new Set(tasks.map((t) => t.id))
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter((dep) => taskIds.has(dep))
  }

  return {
    tasks,
    independentGroups: raw.independent_groups.filter((group) =>
      group.every((id) => taskIds.has(id)),
    ),
    estimatedWorkers: Math.max(1, ...raw.independent_groups.map((g) => g.length)),
  }
}

/**
 * Run the manager agent: analyze the project and decompose the task into a plan.
 * Returns the structured plan for the master to execute.
 */
export async function managerLoop(input: ManagerInput): Promise<ManagerPlan> {
  const { sessionId, projectDir, task, model, apiKey, events, db } = input

  events.push('session.planStarted', sessionId, { sessionId })

  // Build project context
  let tree: string
  let summaryIndex: SummaryEntry[]
  try {
    const entries = scanProject(projectDir)
    tree = buildNestedTree(entries)
    summaryIndex = buildSummaryIndex(projectDir, entries)
  } catch {
    tree = '(unable to read project tree)'
    summaryIndex = []
  }

  const summaryText = formatSummaryIndex(summaryIndex)
  const systemPrompt = buildManagerPrompt(projectDir, task, tree, summaryText)

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ]

  // Persist the user message
  const userSeq = nextSeq(db, sessionId)
  appendMessage(db, sessionId, userSeq, 'user', task)

  // LLM call to get the plan
  const result = await streamChatCompletion(
    { apiKey, model, messages, tools: [] },
    (text) => events.push('session.assistantDelta', sessionId, { text }),
    (thinking) => events.push('session.thinkingDelta', sessionId, { text: thinking }),
  )

  const content = result.message.content ?? ''

  // Parse the JSON response
  let rawPlan: RawPlanResponse
  try {
    // Try to extract JSON from the response (may be wrapped in markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('No JSON object found in response')
    }
    rawPlan = JSON.parse(jsonMatch[0])
  } catch (e) {
    // If parsing fails, create a single-task plan
    rawPlan = {
      tasks: [{
        id: 'task-1',
        title: task.slice(0, 100),
        description: task,
        files: [],
        validation: 'echo "completed"',
        depends_on: [],
        type: 'modify',
      }],
      independent_groups: [['task-1']],
    }
  }

  const plan = parsePlan(rawPlan, projectDir)

  // Persist the plan
  const planSeq = nextSeq(db, sessionId)
  appendMessage(db, sessionId, planSeq, 'assistant', JSON.stringify(plan))

  // Stream plan tasks to UI
  for (const t of plan.tasks) {
    events.push('session.planTask', sessionId, { sessionId, task: t })
  }

  events.push('session.planComplete', sessionId, { sessionId, plan })

  return plan
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
