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

/**
 * Compress history to fit the model context window (E5).
 *
 * Walks complete assistant(+tool_calls) + tool-result units so a pruned
 * tool result never leaves its parent assistant dangling, and vice versa.
 * Incomplete units (assistant tool_calls with missing results) are always
 * dropped, even when the history fits without compression.
 */
export function compressMessages(
  messages: OpenRouterMessage[],
  model: string,
  reserveTokens: number = 2000,
): OpenRouterMessage[] {
  const maxTokens = getModelLimit(model) - reserveTokens

  // Split into units: system alone; assistant with tool_calls + its tool results;
  // other messages as single-message units. Incomplete units are dropped here.
  const units: OpenRouterMessage[][] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const unit: OpenRouterMessage[] = [msg]
      const toolIds = new Set(msg.tool_calls.map(tc => tc.id))
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') {
        unit.push(messages[j])
        toolIds.delete(messages[j].tool_call_id ?? '')
        j++
      }
      // Drop incomplete units (missing tool results) rather than emit dangling
      // tool_calls that providers reject.
      if (toolIds.size === 0) {
        units.push(unit)
        i = j
        continue
      }
      i++
      continue
    }
    units.push([msg])
    i++
  }

  const systemUnits = units.filter(u => u[0]?.role === 'system')
  const rest = units.filter(u => u[0]?.role !== 'system')

  const all: OpenRouterMessage[] = [...systemUnits, ...rest].flat()
  const totalTokens = all.reduce((sum, msg) => sum + estimateTokens(msg), 0)
  if (totalTokens <= maxTokens) return all

  const compressed: OpenRouterMessage[] = []
  let currentTokens = 0

  for (const unit of systemUnits) {
    for (const msg of unit) {
      compressed.push(msg)
      currentTokens += estimateTokens(msg)
    }
  }

  // Keep whole units from the end (most recent context).
  const keptUnits: OpenRouterMessage[][] = []
  for (let k = rest.length - 1; k >= 0; k--) {
    const unit = rest[k]
    const unitTokens = unit.reduce((s, m) => s + estimateTokens(m), 0)
    if (currentTokens + unitTokens > maxTokens) break
    keptUnits.unshift(unit)
    currentTokens += unitTokens
  }

  for (const unit of keptUnits) {
    for (const msg of unit) compressed.push(msg)
  }

  // Still over budget (e.g. huge system or one huge tool result): truncate
  // tool payloads rather than break units.
  if (currentTokens > maxTokens) {
    for (let idx = 0; idx < compressed.length; idx++) {
      const msg = compressed[idx]
      if (msg.role === 'tool' && msg.content && msg.content.length > 500) {
        const truncated = msg.content.slice(0, 500) + '\n... (truncated)'
        const savedTokens = estimateTokens(msg) - estimateTokens({ ...msg, content: truncated })
        compressed[idx] = { ...msg, content: truncated }
        currentTokens -= savedTokens
        if (currentTokens <= maxTokens) break
      }
    }
  }

  return compressed
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

export type ParsePlanResult =
  | { ok: true; plan: DeveloperPlan }
  | { ok: false; error: string }

/**
 * Parse and validate `propose_plan` arguments (E1).
 * - Requires model-supplied unique task `id`s (falls back to `task-N` only when absent).
 * - Unknown `dependsOn` ids are a tool error (not silently filtered).
 */
export function parseProposePlanArgs(raw: unknown): ParsePlanResult {
  const args = raw as {
    tasks?: Array<{
      id?: string
      title: string
      description: string
      instructions?: string[]
      readFile?: string[]
      writeFile?: string[]
      deleteFile?: string[]
      createDir?: string[]
      validation?: string[] | string
      dependsOn?: string[]
      type?: string
      complexity?: string
      validationStrategy?: string
      alternativeApproaches?: string[]
      estimatedDuration?: string
      allowedTools?: string[]
      timeoutSeconds?: number
      retries?: number
      rollback?: string[]
      skipIf?: string[]
    }>
    summary: string
  }

  if (!Array.isArray(args?.tasks) || args.tasks.length === 0) {
    return { ok: false, error: 'Plan has no tasks. Please propose a plan with at least one task.' }
  }

  const tasks: PlannedTask[] = args.tasks.map((t, i) => ({
    id: t.id?.trim() || `task-${i + 1}`,
    title: t.title,
    description: t.description,
    instructions: t.instructions ?? [],
    readFile: t.readFile ?? [],
    writeFile: t.writeFile ?? [],
    deleteFile: t.deleteFile ?? [],
    createDir: t.createDir ?? [],
    validation: Array.isArray(t.validation) ? t.validation : t.validation ? [t.validation] : [],
    dependsOn: t.dependsOn ?? [],
    type: (['create', 'modify', 'delete', 'refactor'].includes(t.type ?? '') ? t.type : 'modify') as PlannedTask['type'],
    complexity: (['low', 'medium', 'high'].includes(t.complexity ?? '') ? t.complexity : 'medium') as PlannedTask['complexity'],
    validationStrategy: (['hierarchical', 'incremental', 'contextAware'].includes(t.validationStrategy ?? '')
      ? t.validationStrategy
      : 'hierarchical') as PlannedTask['validationStrategy'],
    alternativeApproaches: t.alternativeApproaches ?? [],
    estimatedDuration: t.estimatedDuration ? parseInt(t.estimatedDuration, 10) : undefined,
    allowedTools: t.allowedTools,
    timeoutSeconds: t.timeoutSeconds,
    retries: t.retries,
    rollback: t.rollback,
    skipIf: t.skipIf,
  }))

  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) {
      return { ok: false, error: `Duplicate task id '${task.id}'. Every task must have a unique id.` }
    }
    seen.add(task.id)
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!seen.has(dep)) {
        return {
          ok: false,
          error: `Task '${task.id}' depends on unknown task '${dep}'. Only reference ids defined in this plan.`,
        }
      }
    }
  }

  // Compute parallel execution waves. Level 0 is everything with no
  // dependencies; level N is everything whose dependencies all landed in an
  // earlier level.
  const independentGroups: string[][] = []
  const placed = new Set<string>()
  while (placed.size < tasks.length) {
    const wave = tasks
      .filter((t) => !placed.has(t.id) && t.dependsOn.every((dep) => placed.has(dep)))
      .map((t) => t.id)

    if (wave.length === 0) {
      independentGroups.push(tasks.filter((t) => !placed.has(t.id)).map((t) => t.id))
      break
    }

    for (const id of wave) placed.add(id)
    independentGroups.push(wave)
  }

  return {
    ok: true,
    plan: {
      tasks,
      independentGroups,
      estimatedWorkers: Math.max(1, ...independentGroups.map(g => g.length)),
    },
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
  signal?: AbortSignal
}

export type DeveloperTurnResult =
  | { type: 'response'; response: string }
  | { type: 'plan'; plan: DeveloperPlan }

export async function developerConversationTurn(
  input: DeveloperTurnInput,
): Promise<DeveloperTurnResult> {
  const { sessionId, projectDir, userMessage, model, apiKey, handle, messages, summaryIndex, onTextDelta, onThinkingDelta, isInterrupted, signal } = input

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
  // E4: wall-clock + total iteration bounds. Free tools count toward total
  // iterations (they can still run forever) but not toward the tool budget.
  const MAX_WALL_MS = 5 * 60 * 1000
  const MAX_TOTAL_ITERATIONS = 60
  const startedAt = Date.now()
  let totalIterations = 0

  while (toolCallCount < MAX_TOOL_CALLS) {
    if (isInterrupted?.() || signal?.aborted) {
      break
    }
    totalIterations++
    if (totalIterations > MAX_TOTAL_ITERATIONS || Date.now() - startedAt > MAX_WALL_MS) {
      break
    }

    // Compress messages to fit within context window
    const compressedMessages = compressMessages(messages, model)

    const result = await streamChatCompletion(
      { apiKey, model, messages: compressedMessages, tools: toolSpecs, signal },
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

        const parsedPlan = parseProposePlanArgs(parsed)
        if (!parsedPlan.ok) {
          messages.push({
            role: 'tool',
            content: `Error: ${parsedPlan.error}`,
            tool_call_id: toolCall.id,
          })
          continue
        }
        const plan = parsedPlan.plan
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
