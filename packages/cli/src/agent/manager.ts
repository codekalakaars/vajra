import type { ManagerPlan, PlannedTask, ToolName } from '@codekalakaars/vajra-protocol'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'
import { getManagerToolSpecs, parseToolCall } from './tools.js'
import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, formatSummaryIndexHierarchical, searchSummary, type SummaryEntry } from './summary.js'

const FREE_TOOLS = new Set(['search_files'])

export interface LaunchHandle {
  callTool(tool: string, args: unknown): Promise<unknown>
}

// Approximate tokens per character (conservative estimate)
const CHARS_PER_TOKEN = 4

// Maximum context sizes by model (in tokens)
const MODEL_LIMITS: Record<string, number> = {
  'nvidia/nemotron-3-ultra-550b-a55b:free': 1000000,
  'nvidia/nemotron-3-super-120b-a12b:free': 262144,
  'nvidia/nemotron-3.5-lightning:free': 1000000,
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 256000,
  'dots-studio/dots-3-note-preview:free': 512000,
  'google/gemma-4-31b-it:free': 262144,
  'google/gemma-4-26b-a4b-it:free': 262144,
  'nex-agi/nex-n2.5-pro:free': 262144,
  'poolside/laguna-s-2.1:free': 262144,
  'poolside/laguna-xs-2.1:free': 262144,
  'cohere/north-mini-code:free': 256000,
  'inclusionai/ling-3.0-flash-vl:free': 262144,
  // Zen models
  'deepseek-v4-flash-free': 128000,
  'mimo-v2.5-free': 128000,
  'nemotron-3-ultra-free': 1000000,
  'nemotron-3.5-lightning-free': 1000000,
  'nemotron-3-super-free': 262144,
  'ling-3.0-flash-fin-free': 128000,
  'gpt-5.5': 256000,
  'gpt-5.4': 256000,
  'gpt-5.4-mini': 128000,
  'deepseek-v4-pro': 128000,
  'kimi-k3': 128000,
  'big-pickle': 128000,
  'mimo-v2.5': 128000,
  'mimo-v2.5-pro': 128000,
  default: 128000,
}

function getModelLimit(model: string): number {
  if (MODEL_LIMITS[model]) return MODEL_LIMITS[model]
  for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
    if (model.includes(key)) return limit
  }
  return MODEL_LIMITS.default
}

function estimateTokens(message: OpenRouterMessage): number {
  let tokens = 0
  if (message.content) {
    tokens += Math.ceil(message.content.length / CHARS_PER_TOKEN)
  }
  if (message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      tokens += Math.ceil(toolCall.function.name.length / CHARS_PER_TOKEN)
      tokens += Math.ceil(toolCall.function.arguments.length / CHARS_PER_TOKEN)
    }
  }
  tokens += 4 // Overhead per message
  return tokens
}

function compressMessages(messages: OpenRouterMessage[], model: string, reserveTokens: number = 2000): OpenRouterMessage[] {
  const maxTokens = getModelLimit(model) - reserveTokens
  const totalTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg), 0)

  // If under limit, return as-is
  if (totalTokens <= maxTokens) return messages

  const compressed: OpenRouterMessage[] = []
  let currentTokens = 0

  // Find system prompt (usually first message)
  const systemIdx = messages.findIndex(m => m.role === 'system')
  if (systemIdx >= 0) {
    compressed.push(messages[systemIdx])
    currentTokens += estimateTokens(messages[systemIdx])
  }

  // Keep last 6 messages for recent context
  const recentCount = 6
  const recentStart = Math.max(0, messages.length - recentCount)
  const recentMessages = messages.slice(recentStart)

  // Add recent messages
  for (const msg of recentMessages) {
    if (compressed.includes(msg)) continue
    const msgTokens = estimateTokens(msg)
    if (currentTokens + msgTokens <= maxTokens) {
      compressed.push(msg)
      currentTokens += msgTokens
    }
  }

  // If still over limit, compress older tool results
  if (currentTokens > maxTokens) {
    for (let i = 0; i < compressed.length; i++) {
      const msg = compressed[i]
      if (msg.role === 'tool' && msg.content && msg.content.length > 500) {
        const truncated = msg.content.slice(0, 500) + '\n... (truncated)'
        const savedTokens = estimateTokens(msg) - estimateTokens({ ...msg, content: truncated })
        compressed[i] = { ...msg, content: truncated }
        currentTokens -= savedTokens
        if (currentTokens <= maxTokens) break
      }
    }
  }

  // Add summary message if we compressed
  if (compressed.length < messages.length) {
    const skippedCount = messages.length - compressed.length
    compressed.splice(1, 0, {
      role: 'system',
      content: `[System: ${skippedCount} earlier messages were compressed to fit context window]`,
    })
  }

  return compressed
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
    '- If the user provides a detailed task description, skip clarifying questions and go straight to propose_plan',
    '- Only ask clarifying questions if the task is vague or ambiguous',
    '- Only read files you need to understand the task',
    '- Tasks must be HIGHLY PRESCRIPTIVE — the worker should not need to think',
    '',
    'When calling propose_plan, each task MUST include:',
    '- title: Short title',
    '- description: What needs to be done and why',
    '- instructions: EXACT step-by-step instructions (e.g. "Add try-catch around line 42 in src/api.ts")',
    '- readFile: Files the worker needs to read for context',
    '- writeFile: Files the worker will create or modify',
    '- deleteFile: Files to delete',
    '- createDir: Directories to create',
    '- validation: Commands to run after completion (must exit 0 on success). IMPORTANT: Do NOT use commands that require a running server (npm test, curl localhost, etc.) unless the task explicitly starts the server. Use syntax checks (node --check, tsc --noEmit) or static analysis (eslint) instead.',
    '- dependsOn: Task IDs this depends on',
    '- type: create, modify, delete, or refactor',
    '- complexity: low, medium, or high (affects task sizing)',
    '- rollback: Commands to undo changes if validation fails (optional)',
    '- alternativeApproaches: Different ways to solve this task (optional)',
    '',
    'CRITICAL: Instructions should be so specific that a worker with no context can execute them.',
    'Bad: "Add error handling to the API"',
    'Good: "In src/api/users.ts, wrap the db.query() call at line 42 in try-catch. In the catch block, return { status: 500, error: e.message }. Import HttpError from src/utils/errors.ts if not already imported."',
    '',
    'Tasks should be independent where possible; specify dependencies explicitly.',
    'Aim for 2-8 tasks; keep related work together.',
    '',
    'Task Sizing Guidelines:',
    '- Low complexity: Single file, simple changes (1-2 hours)',
    '- Medium complexity: Multiple files, moderate changes (2-4 hours)',
    '- High complexity: Architecture changes, many files (4+ hours)',
    '',
    'Error Recovery:',
    '- rollback: Commands to undo changes if validation fails',
    '- alternativeApproaches: Different ways to solve this task',
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

function parseProposePlanArgs(raw: unknown): ManagerPlan {
  const args = raw as {
    tasks?: Array<{
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
      complexity?: string
      validationStrategy?: string
      alternativeApproaches?: string[]
      estimatedDuration?: string
      allowedTools?: string[]
      timeout?: number
      retries?: number
      rollback?: string[]
      skipIf?: string[]
    }>
    summary: string
  }

  const tasks: PlannedTask[] = (args.tasks ?? []).map((t, i) => ({
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
    complexity: (['low', 'medium', 'high', 'critical'].includes(t.complexity ?? '') ? t.complexity : 'medium') as PlannedTask['complexity'],
    validationStrategy: (['hierarchical', 'targeted', 'full', 'skip'].includes(t.validationStrategy ?? '') ? t.validationStrategy : 'hierarchical') as PlannedTask['validationStrategy'],
    alternativeApproaches: t.alternativeApproaches ?? [],
    estimatedDuration: t.estimatedDuration ? parseInt(t.estimatedDuration, 10) : undefined,
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

function detectAndRemoveCircularDeps(tasks: PlannedTask[]): PlannedTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const visited = new Set<string>()
  const recursionStack = new Set<string>()
  const circularDeps = new Set<string>()

  function dfs(taskId: string): boolean {
    if (recursionStack.has(taskId)) {
      circularDeps.add(taskId)
      return true
    }
    if (visited.has(taskId)) return false

    visited.add(taskId)
    recursionStack.add(taskId)

    const task = taskMap.get(taskId)
    if (task) {
      for (const dep of task.dependsOn) {
        if (dfs(dep)) {
          circularDeps.add(taskId)
        }
      }
    }

    recursionStack.delete(taskId)
    return circularDeps.has(taskId)
  }

  for (const task of tasks) {
    dfs(task.id)
  }

  if (circularDeps.size > 0) {
    console.warn(`Removing circular dependencies from tasks: ${[...circularDeps].join(', ')}`)
    for (const task of tasks) {
      if (circularDeps.has(task.id)) {
        task.dependsOn = []
      } else {
        task.dependsOn = task.dependsOn.filter(dep => !circularDeps.has(dep))
      }
    }
  }

  return tasks
}

function addFileLevelDependencies(tasks: PlannedTask[]): PlannedTask[] {
  for (const task of tasks) {
    for (const other of tasks) {
      if (task.id === other.id) continue
      const writesToReadFiles = other.writeFile.some(file =>
        task.readFile.includes(file) || task.writeFile.includes(file)
      )
      if (writesToReadFiles && !task.dependsOn.includes(other.id)) {
        task.dependsOn.push(other.id)
      }
    }
  }
  return tasks
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

    const summaryText = formatSummaryIndexHierarchical(summaryIndex)
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
    // Compress messages to fit within context window
    const compressedMessages = compressMessages(messages, model)

    const result = await streamChatCompletion(
      { apiKey, model, messages: compressedMessages, tools: toolSpecs },
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
        if (plan.tasks.length === 0) {
          messages.push({
            role: 'tool',
            content: 'Error: Plan has no tasks. Please propose a plan with at least one task.',
            tool_call_id: toolCall.id,
          })
          continue
        }
        plan.tasks = detectAndRemoveCircularDeps(plan.tasks)
        plan.tasks = addFileLevelDependencies(plan.tasks)
        messages.push({
          role: 'tool',
          content: 'Plan proposed. Awaiting user review.',
          tool_call_id: toolCall.id,
        })
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
