import type { ManagerPlan, PlannedTask, ToolName } from '@codekalakaars/vajra-protocol'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'
import { getManagerToolSpecs, parseToolCall } from './tools.js'
import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, formatSummaryIndex, searchSummary, type SummaryEntry } from './summary.js'

const FREE_TOOLS = new Set(['search_files'])

export interface LaunchHandle {
  callTool(tool: string, args: unknown): Promise<unknown>
}

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
    '4. When you have enough context, produce a DETAILED plan using propose_plan',
    '',
    'You have access to these tools:',
    '- search_files(query): search the summary index to find relevant files (FREE)',
    '- read_file(path): read a file to understand the codebase',
    '- list_files(path): list directory contents',
    '- propose_plan(tasks, summary): propose a detailed plan when ready',
    '',
    'IMPORTANT RULES:',
    '- Do NOT call propose_plan on the first message — gather context first',
    '- Ask 2-4 clarifying questions before planning',
    '- Only read files you need to understand the task',
    '- Tasks must be HIGHLY PRESCRIPTIVE — the worker should not need to think',
    '',
    'When calling propose_plan, each task MUST include:',
    '- title: Short title',
    '- description: What needs to be done and why',
    '- instructions: EXACT step-by-step instructions',
    '- readFile: Files the worker needs to read for context',
    '- writeFile: Files the worker will create or modify',
    '- deleteFile: Files to delete',
    '- createDir: Directories to create',
    '- validation: Commands to run after completion (must exit 0 on success)',
    '- dependsOn: Task IDs this depends on',
    '- type: create, modify, delete, or refactor',
    '',
    'CRITICAL: Instructions should be so specific that a worker with no context can execute them.',
    '',
    'Project directory: ' + projectDir,
    '',
    'Project structure:',
    tree,
    '',
    'File summaries:',
    summary,
  ].join('\n')
}

function parseProposePlanArgs(raw: unknown): ManagerPlan {
  const args = raw as {
    tasks: Array<{
      title: string
      description: string
      instructions: string[]
      readFile: string[]
      writeFile: string[]
      deleteFile: string[]
      createDir: string[]
      validation: string[]
      dependsOn: string[]
      type: string
      allowedTools?: string[]
      timeout?: number
      retries?: number
      rollback?: string[]
      skipIf?: string[]
    }>
    summary: string
  }

  const tasks: PlannedTask[] = args.tasks.map((t, i) => ({
    id: `task-${i + 1}`,
    title: t.title,
    description: t.description,
    instructions: t.instructions ?? [],
    readFile: t.readFile ?? [],
    writeFile: t.writeFile ?? [],
    deleteFile: t.deleteFile ?? [],
    createDir: t.createDir ?? [],
    validation: t.validation ?? [],
    dependsOn: t.dependsOn ?? [],
    type: (['create', 'modify', 'delete', 'refactor'].includes(t.type) ? t.type : 'modify') as PlannedTask['type'],
    allowedTools: t.allowedTools,
    timeout: t.timeout,
    maxRetries: t.retries,
    rollback: t.rollback,
    skipIf: t.skipIf,
  }))

  const taskIds = new Set(tasks.map(t => t.id))
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter(dep => taskIds.has(dep))
  }

  const independentGroups: string[][] = []
  const assigned = new Set<string>()
  for (const task of tasks) {
    if (assigned.has(task.id)) continue
    const group = [task.id]
    assigned.add(task.id)
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
    estimatedWorkers: Math.max(1, ...independentGroups.map(g => g.length)),
  }
}

export interface ManagerTurnInput {
  sessionId: string
  projectDir: string
  userMessage: string
  model: string
  apiKey: string
  handle: LaunchHandle
  messages: OpenRouterMessage[]
  summaryIndex: SummaryEntry[]
  onTextDelta?: (text: string) => void
  onThinkingDelta?: (text: string) => void
}

export type ManagerTurnResult =
  | { type: 'response'; response: string }
  | { type: 'plan'; plan: ManagerPlan }

export async function managerConversationTurn(
  input: ManagerTurnInput,
): Promise<ManagerTurnResult> {
  const { sessionId, projectDir, userMessage, model, apiKey, handle, messages, summaryIndex, onTextDelta, onThinkingDelta } = input

  if (messages.length === 0) {
    let tree = ''
    try {
      const entries = scanProject(projectDir)
      tree = buildNestedTree(entries)
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

  messages.push({ role: 'user', content: userMessage })

  const toolSpecs = getManagerToolSpecs()
  let toolCallCount = 0
  const MAX_TOOL_CALLS = 30

  while (toolCallCount < MAX_TOOL_CALLS) {
    const result = await streamChatCompletion(
      { apiKey, model, messages, tools: toolSpecs },
      text => onTextDelta?.(text),
      thinking => onThinkingDelta?.(thinking),
    )

    if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
      const content = result.message.content ?? ''
      messages.push(result.message)
      return { type: 'response', response: content }
    }

    messages.push(result.message)

    for (const toolCall of result.message.tool_calls) {
      if (toolCall.function.name === 'propose_plan') {
        let parsed: unknown
        try {
          parsed = JSON.parse(toolCall.function.arguments)
        } catch {
          messages.push({
            role: 'tool',
            content: 'Error: propose_plan arguments were not valid JSON. Please try again.',
            tool_call_id: toolCall.id,
          })
          continue
        }

        const plan = parseProposePlanArgs(parsed)
        return { type: 'plan', plan }
      }

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
        const args = parsed.call.args as { query: string }
        resultContent = searchSummary(summaryIndex, args.query)
      } else {
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

  const fallbackContent = 'I have enough context. Let me propose a plan.'
  messages.push({ role: 'assistant', content: fallbackContent })
  return { type: 'response', response: fallbackContent }
}
