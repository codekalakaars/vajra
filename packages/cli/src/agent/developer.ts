import type { DeveloperPlan, PlannedTask, ToolName } from '@codekalakaars/vajra-protocol'
import { streamChatCompletion, type OpenRouterMessage } from './openrouter.js'
import { getDeveloperToolSpecs, parseToolCall } from './tools.js'
import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, formatSummaryIndexHierarchical, searchSummary, type SummaryEntry } from './summary.js'

const FREE_TOOLS = new Set(['search_files'])

export interface LaunchHandle {
  callTool(tool: string, args: unknown): Promise<unknown>
}

// Approximate tokens per character (conservative estimate)
const CHARS_PER_TOKEN = 4

// Default context limits by provider (in tokens)
// Most models fall into these ranges; specific models can override if known
const PROVIDER_DEFAULTS: Record<string, number> = {
  'nvidia/': 256000,      // NVIDIA Nemotron models
  'google/': 256000,      // Google Gemma models
  'meta-llama/': 128000,  // Meta Llama models
  'openai/': 128000,      // OpenAI models
  'anthropic/': 200000,   // Anthropic Claude models
  'zen/': 128000,         // Zen models
  'go/': 128000,          // Go models
  default: 128000,
}

function getModelLimit(model: string): number {
  for (const [prefix, limit] of Object.entries(PROVIDER_DEFAULTS)) {
    if (prefix !== 'default' && model.startsWith(prefix)) return limit
  }
  return PROVIDER_DEFAULTS.default
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

  // Keep last 6 messages for recent context — but ensure tool-call pairs stay
  // together. Walk backwards from the end and collect complete units (assistant
  // with tool_calls + all following tool results).
  const recentCount = 6
  const recentStart = Math.max(0, messages.length - recentCount)
  const recentMessages = messages.slice(recentStart)

  for (const msg of recentMessages) {
    if (compressed.includes(msg)) continue
    const msgTokens = estimateTokens(msg)
    if (currentTokens + msgTokens <= maxTokens) {
      compressed.push(msg)
      currentTokens += msgTokens
    }
  }

  // Ensure every tool result in compressed has its parent assistant tool_call
  // message. If a tool result was included but its assistant was not, drop the
  // orphaned tool result.
  const toolCallIds = new Set<string>()
  for (const msg of compressed) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIds.add(tc.id)
      }
    }
  }
  const pruned = compressed.filter(msg => {
    if (msg.role === 'tool' && msg.tool_call_id && !toolCallIds.has(msg.tool_call_id)) {
      currentTokens -= estimateTokens(msg)
      return false
    }
    return true
  })

  // If still over limit, truncate tool result payloads (each) rather than
  // dropping entire turns.
  if (currentTokens > maxTokens) {
    for (let i = 0; i < pruned.length; i++) {
      const msg = pruned[i]
      if (msg.role === 'tool' && msg.content && msg.content.length > 500) {
        const truncated = msg.content.slice(0, 500) + '\n... (truncated)'
        const savedTokens = estimateTokens(msg) - estimateTokens({ ...msg, content: truncated })
        pruned[i] = { ...msg, content: truncated }
        currentTokens -= savedTokens
        if (currentTokens <= maxTokens) break
      }
    }
  }

  return pruned
}

function buildDeveloperConversationPrompt(
  projectDir: string,
  tree: string,
  summary: string,
): string {
  return [
    'You are the Developer — a software engineering planning agent.',
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
    '- Do NOT call propose_plan on the first message — read files first to understand the codebase',
    '- If the user provides specific requirements (validation rules, file names, libraries to use), skip ALL clarifying questions and go directly to propose_plan',
    '- Only ask clarifying questions if the task is extremely vague (e.g., "fix the bug" with no context)',
    '- NEVER ask more than 2 clarifying questions — prefer making reasonable defaults',
    '- Only read files you need to understand the task',
    '- Tasks must be HIGHLY PRESCRIPTIVE — the worker should not need to think',
    '- NEVER put "run tests" or "verify" as the first task — always edit code first, then test',
    '',
    'When calling propose_plan, each task MUST include:',
    '- title: Short title',
    '- description: What needs to be done and why',
    '- instructions: EXACT step-by-step instructions (e.g. "Add try-catch around line 42 in src/api.ts")',
    '- readFile: Files the worker needs to read for context',
    '- writeFile: Files the worker will create or modify',
    '- validation: Commands to run after completion (must exit 0 on success). IMPORTANT: Do NOT use commands that require a running server (npm test, curl localhost, etc.) unless the task explicitly starts the server. Use syntax checks (node --check, tsc --noEmit) or static analysis (eslint) instead.',
    '- dependsOn: Task IDs this depends on',
    '- type: create, modify, or refactor',
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

function parseProposePlanArgs(raw: unknown): DeveloperPlan {
  const args = raw as {
    tasks?: Array<{
      title: string
      description: string
      instructions: string[]
      readFile: string[]
      writeFile: string[]
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
    deleteFile: [],
    createDir: [],
    validation: t.validation ?? [],
    dependsOn: t.dependsOn ?? [],
    type: (['create', 'modify', 'refactor'].includes(t.type) ? t.type : 'modify') as PlannedTask['type'],
    complexity: (['low', 'medium', 'high'].includes(t.complexity ?? '') ? t.complexity : 'medium') as PlannedTask['complexity'],
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

  // Compute parallel execution waves. Level 0 is everything with no
  // dependencies; level N is everything whose dependencies all landed in an
  // earlier level. Tasks sharing a level can genuinely run in parallel — the
  // previous greedy pass put a task in the same group as its own dependency,
  // so "independent group" did not mean independent.
  const independentGroups: string[][] = []
  const placed = new Set<string>()
  while (placed.size < tasks.length) {
    const wave = tasks
      .filter((t) => !placed.has(t.id) && t.dependsOn.every((dep) => placed.has(dep)))
      .map((t) => t.id)

    // Nothing can advance — whatever is left is unresolvable (e.g. a cycle
    // that survived cleanup). Emit it as a final wave instead of spinning.
    if (wave.length === 0) {
      independentGroups.push(tasks.filter((t) => !placed.has(t.id)).map((t) => t.id))
      break
    }

    for (const id of wave) placed.add(id)
    independentGroups.push(wave)
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
  // Edges always point backwards in plan order: a later task that touches a
  // file an earlier task writes waits for it. Adding the edge in both
  // directions (as this used to) deadlocks the queue whenever two tasks touch
  // the same file — neither ever becomes ready and the plan silently stalls.
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    for (let j = 0; j < i; j++) {
      const earlier = tasks[j]
      const writesFileWeTouch = earlier.writeFile.some(
        (file) => task.readFile.includes(file) || task.writeFile.includes(file),
      )
      if (writesFileWeTouch && !task.dependsOn.includes(earlier.id)) {
        task.dependsOn.push(earlier.id)
      }
    }
  }

  return tasks
}

export interface DeveloperTurnInput {
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
  isInterrupted?: () => boolean
}

export type DeveloperTurnResult =
  | { type: 'response'; response: string }
  | { type: 'plan'; plan: DeveloperPlan }

export async function developerConversationTurn(
  input: DeveloperTurnInput,
): Promise<DeveloperTurnResult> {
  const { sessionId, projectDir, userMessage, model, apiKey, handle, messages, summaryIndex, onTextDelta, onThinkingDelta, isInterrupted } = input

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
      content: buildDeveloperConversationPrompt(projectDir, tree, summaryText),
    })
  }

  messages.push({ role: 'user', content: userMessage })

  const toolSpecs = getDeveloperToolSpecs()
  let toolCallCount = 0
  const MAX_TOOL_CALLS = 30

  while (toolCallCount < MAX_TOOL_CALLS) {
    if (isInterrupted?.()) {
      break
    }

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
        plan.tasks = addFileLevelDependencies(plan.tasks)
        // Must run AFTER the file-level pass, which can introduce edges the
        // planner never declared.
        plan.tasks = detectAndRemoveCircularDeps(plan.tasks)
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
      }

      // Budget exhausted — still append a synthetic result so the tool-call
      // chain is never left dangling. The provider will reject a conversation
      // with an assistant tool_call that has no matching tool result.
      if (toolCallCount > MAX_TOOL_CALLS) {
        messages.push({
          role: 'tool',
          content: 'Error: Tool call budget exhausted. Please produce a plan based on what you have learned so far.',
          tool_call_id: toolCall.id,
        })
        continue
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

  const fallbackContent = isInterrupted?.()
    ? 'Interrupted by user.'
    : 'I have enough context. Let me propose a plan.'
  messages.push({ role: 'assistant', content: fallbackContent })
  return { type: 'response', response: fallbackContent }
}
