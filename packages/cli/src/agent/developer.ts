import type {
  DeveloperPlan,
  EditSpec,
  PlanEvidence,
  PlannedTask,
  PlannedTaskInput,
  ProjectFileEntry,
  ToolName,
} from '@codekalakaars/vajra-protocol'
import {
  planParallel,
  proposePlanTool,
  validateContracts,
  validatePlan,
} from '@codekalakaars/vajra-protocol'
import { resolve } from 'node:path'
import { deriveIndexBudget } from '@codekalakaars/vajra-agent-core'
import { streamChatCompletion, type ChatMessage, type ToolCall } from './chat.js'
import { getDeveloperToolSpecs, parseToolCall } from './tools.js'
import { tokenizeCommand } from '../tools/handle.js'
import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, formatSummaryIndexHierarchical, searchSummary, type SummaryEntry } from './summary.js'
import {
  startHeartbeat,
  summarizePlanTaskCount,
  summarizeToolCall,
  summarizeToolResult,
  type AgentEvent,
} from '../session/ui.js'

const FREE_TOOLS = new Set(['search_files'])

/**
 * Tools that only observe. These may run concurrently within one assistant
 * message; anything that writes keeps the model's original order, because a
 * later mutation can depend on an earlier one.
 */
const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'search_content'])

export interface LaunchHandle {
  callTool(tool: string, args: unknown): Promise<unknown>
}

// Approximate tokens per character (conservative estimate)
const CHARS_PER_TOKEN = 4

// Default context limits by provider (in tokens)
// Most models fall into these ranges; specific models can override if known
const PROVIDER_DEFAULTS: Record<string, number> = {
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

function estimateTokens(message: ChatMessage): number {
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
  messages: ChatMessage[],
  model: string,
  reserveTokens: number = 2000,
): ChatMessage[] {
  const maxTokens = getModelLimit(model) - reserveTokens

  // Split into units: system alone; assistant with tool_calls + its tool results;
  // other messages as single-message units. Incomplete units are dropped here.
  const units: ChatMessage[][] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const unit: ChatMessage[] = [msg]
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

  const all: ChatMessage[] = [...systemUnits, ...rest].flat()
  const totalTokens = all.reduce((sum, msg) => sum + estimateTokens(msg), 0)
  if (totalTokens <= maxTokens) return all

  const compressed: ChatMessage[] = []
  let currentTokens = 0

  for (const unit of systemUnits) {
    for (const msg of unit) {
      compressed.push(msg)
      currentTokens += estimateTokens(msg)
    }
  }

  // Keep whole units from the end (most recent context).
  const keptUnits: ChatMessage[][] = []
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
    '- run_baseline(command, args, cwd): run a candidate verify command BEFORE any changes, to record whether it currently passes',
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
    '',
    'PLANNING DISCIPLINE — you will be rejected if you skip these:',
    '',
    '1. READ BEFORE YOU CITE. Every file you list in `context` or `edits` must be one',
    '   you actually called read_file on this session. Listing a file you have not',
    '   opened is the most common way a plan fails.',
    '',
    '2. ANCHOR EVERY MODIFY. For each edit with op=modify, copy the exact text where',
    '   the change goes, verbatim from the file, including indentation. It must appear',
    '   EXACTLY ONCE in that file. If your anchor is ambiguous, extend it with the',
    '   surrounding lines rather than shortening it.',
    '',
    '3. PROVE THE CHANGE. Every task needs at least one verify command with',
    '   kind=proves-change — one that FAILS right now and passes once the task is',
    '   done. Run it with run_baseline before you propose it. A command that already',
    '   passes proves nothing; mark that kind=regression-guard instead.',
    '',
    '4. ARGV, NOT SHELL. Commands run without a shell. Write',
    '   {command: "pnpm", args: ["--filter", "x", "test"]}, never "pnpm x && pnpm y".',
    '',
    '5. ONE OWNER PER FILE. Two tasks may only run at the same time if they edit',
    '   completely different files. If two tasks must touch the same file, put one in',
    "   the other's dependsOn. If a task reads a file another task edits, it must",
    '   depend on that task — otherwise it may read a half-written file.',
    '',
    '6. PIN SHARED DECISIONS. When two tasks must agree on something neither file',
    '   shows — a return shape, a field name, which module owns a table — add it to',
    '   `contracts` with the statement written out in full. Assume the agent reading',
    '   it has seen nothing else: no "as discussed", no "the above".',
  ].join('\n')
}

export type ParsePlanResult =
  | { ok: true; plan: DeveloperPlan }
  | { ok: false; error: string }

function describeEdit(edit: EditSpec): string {
  if (edit.op === 'create') return `Create ${edit.path}: ${edit.change}`
  if (edit.op === 'delete') return `Delete ${edit.path}: ${edit.change}`
  return edit.anchor
    ? `In ${edit.path}, at the text \`${edit.anchor}\`: ${edit.change}`
    : `In ${edit.path}: ${edit.change}`
}

/**
 * Lower a task with structured `context`/`edits`/`verify` to the flat fields
 * the current executor consumes (§8). Structured fields, when present,
 * supersede the flat ones; a task that omits them passes through unchanged.
 */
function lower(task: PlannedTask): PlannedTask {
  const context = task.context ?? []
  const edits = task.edits ?? []

  return {
    ...task,
    readFile: context.length ? context.map((c) => c.path) : task.readFile,
    writeFile: edits.length
      ? edits.filter((e) => e.op !== 'delete').map((e) => e.path)
      : task.writeFile,
    deleteFile: edits.length
      ? edits.filter((e) => e.op === 'delete').map((e) => e.path)
      : task.deleteFile,
    instructions: edits.length ? edits.map(describeEdit) : task.instructions,
    validation: task.verify?.length
      ? task.verify.map((v) => [v.command, ...(v.args ?? [])].join(' '))
      : task.validation,
  }
}

/**
 * Parse and validate `propose_plan` arguments (E1).
 * - Requires model-supplied unique task `id`s (falls back to `task-N` only when absent).
 * - Unknown `dependsOn` ids are a tool error (not silently filtered).
 */
export function parseProposePlanArgs(raw: unknown, projectDir?: string): ParsePlanResult {
  const args = raw as {
    tasks?: Array<{
      id?: string
      title: string
      description: string
      context?: PlannedTaskInput['context']
      edits?: PlannedTaskInput['edits']
      verify?: PlannedTaskInput['verify']
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

  const tasks: PlannedTask[] = args.tasks.map((t, i) => lower({
    id: t.id?.trim() || `task-${i + 1}`,
    title: t.title,
    description: t.description,
    context: t.context,
    edits: t.edits,
    verify: t.verify,
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

  const parallel = planParallel(tasks, projectDir)
  if (parallel.errors.length > 0) {
    return {
      ok: false,
      error: `Plan rejected:\n- ${parallel.errors.join('\n- ')}`,
    }
  }

  return {
    ok: true,
    plan: {
      tasks,
      independentGroups: parallel.waves,
      estimatedWorkers: Math.max(1, ...parallel.waves.map(g => g.length)),
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

/** Canonical key for a baseline observation: argv (tokenized so a bundled
 *  command string and an argv-form one match) plus the resolved cwd. */
function baselineKey(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  projectDir: string,
): string {
  const tokenized = tokenizeCommand(command)
  const argv = tokenized.ok ? [...tokenized.argv, ...args] : [command, ...args]
  return JSON.stringify([argv, resolve(projectDir, cwd ?? '.')])
}

function hasStructuredFields(tasks: readonly PlannedTaskInput[]): boolean {
  return tasks.some(
    (t) => (t.edits?.length ?? 0) > 0 || (t.context?.length ?? 0) > 0 || (t.verify?.length ?? 0) > 0,
  )
}

/**
 * Build the evidence the validator checks against: every file read this turn,
 * and a baseline exit code for each verify entry the model actually ran.
 */
function buildEvidence(
  filesRead: ReadonlyMap<string, string>,
  baselinesByCommand: ReadonlyMap<string, number>,
  tasks: readonly PlannedTaskInput[],
  projectDir: string,
): PlanEvidence {
  const baselines = new Map<string, number>()
  for (const task of tasks) {
    (task.verify ?? []).forEach((v, i) => {
      const exit = baselinesByCommand.get(baselineKey(v.command, v.args ?? [], v.cwd, projectDir))
      if (exit !== undefined) {
        baselines.set(`${task.id}#${i}`, exit)
      }
    })
  }
  return { filesRead, baselines }
}

/** Write harness observations (§1) onto the accepted plan: occurrences of each
 *  anchor in the file it was read from, and the baseline exit per verify entry. */
function enrichHarnessEvidence(
  tasks: PlannedTask[],
  filesRead: ReadonlyMap<string, string>,
  baselinesByCommand: ReadonlyMap<string, number>,
  projectDir: string,
): void {
  for (const task of tasks) {
    for (const edit of task.edits ?? []) {
      if (edit.anchor) {
        const content = filesRead.get(edit.path)
        if (content !== undefined) {
          edit.anchorOccurrences = content.split(edit.anchor).length - 1
        }
      }
    }
    for (const v of task.verify ?? []) {
      const exit = baselinesByCommand.get(baselineKey(v.command, v.args ?? [], v.cwd, projectDir))
      if (exit !== undefined) {
        v.baselineExit = exit
      }
    }
  }
}

/**
 * Explicit depth for the project tree. Four levels keeps a four-deep package
 * layout fully named; the shrink-to-fit loop in buildInitialPromptContext only
 * ever renders shallower than this.
 */
const PROJECT_TREE_DEPTH = 4

/**
 * Build a summary index that can actually fill `budget`.
 *
 * buildSummaryIndex truncates every call to a fixed internal raw-size cap
 * calibrated to the old 4,000-char formatted budget, so one call can only ever
 * show a sliver of the repo — that was the 7.5% → 5.9% coverage regression.
 * Re-run it over the entries not yet indexed until the formatted index would
 * fill the budget or the repo is exhausted. Every call ranks its input the
 * same way, so the union is the global rank order cut at the budget.
 */
function buildIndexWithinBudget(
  projectDir: string,
  entries: ProjectFileEntry[],
  budget: number,
): SummaryEntry[] {
  const index: SummaryEntry[] = []
  const seen = new Set<string>()
  let remaining = entries

  while (formatSummaryIndexHierarchical(index, budget).length < budget) {
    const batch = buildSummaryIndex(projectDir, remaining)
    if (batch.length === 0) break
    for (const entry of batch) {
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      index.push(entry)
    }
    remaining = remaining.filter(entry => !seen.has(entry.path))
  }

  return index
}

export interface InitialPromptContext {
  tree: string
  summaryText: string
  summaryBudget: number
}

/**
 * Build the pieces of the Developer's system prompt: a summary index sized to
 * this model's derived budget, and a project tree that never outgrows it —
 * the tree is names-only, so the signal-dense index always wins the space.
 */
export function buildInitialPromptContext(
  projectDir: string,
  summaryIndex: SummaryEntry[],
  model: string,
): InitialPromptContext {
  const summaryBudget = deriveIndexBudget(getModelLimit(model))

  let entries: ProjectFileEntry[] = []
  let tree = '(unable to read project tree)'
  try {
    entries = scanProject(projectDir)
    tree = buildNestedTree(entries, PROJECT_TREE_DEPTH)
  } catch {
    entries = []
  }

  if (entries.length > 0 && summaryIndex.length === 0) {
    try {
      summaryIndex.push(...buildIndexWithinBudget(projectDir, entries, summaryBudget))
    } catch {
      // Indexing failed; the prompt falls back to whatever the caller staged.
    }
  }

  const summaryText = formatSummaryIndexHierarchical(summaryIndex, summaryBudget)

  // Names-only context must never cost more than the indexed symbols,
  // exports and previews it accompanies.
  let depth = PROJECT_TREE_DEPTH
  while (
    entries.length > 0 &&
    depth > 1 &&
    tree.length > Math.min(summaryText.length, summaryBudget)
  ) {
    depth -= 1
    tree = buildNestedTree(entries, depth)
  }

  return { tree, summaryText, summaryBudget }
}

export interface DeveloperTurnInput {
  sessionId: string
  projectDir: string
  userMessage: string
  model: string
  apiKey: string
  handle: LaunchHandle
  messages: ChatMessage[]
  summaryIndex: SummaryEntry[]
  onTextDelta?: (text: string) => void
  onThinkingDelta?: (text: string) => void
  isInterrupted?: () => boolean
  signal?: AbortSignal
  /** Sub-task progress for the UI port. Observability only. */
  onAgentEvent?: (event: AgentEvent) => void
}

export type DeveloperTurnResult =
  | { type: 'response'; response: string }
  | { type: 'plan'; plan: DeveloperPlan }

export async function developerConversationTurn(
  input: DeveloperTurnInput,
): Promise<DeveloperTurnResult> {
  const { sessionId, projectDir, userMessage, model, apiKey, handle, messages, summaryIndex, onTextDelta, onThinkingDelta, isInterrupted, signal, onAgentEvent } = input

  const agent = { role: 'developer' } as const
  const emit = (event: AgentEvent): void => onAgentEvent?.(event)
  const emitToolEnd = (
    callId: string,
    tool: string,
    ok: boolean,
    startedAt: number,
    detail?: string,
  ): void => {
    emit({
      type: 'tool-end',
      agent,
      callId,
      tool,
      ok,
      ms: Date.now() - startedAt,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  type Precomputed = { content: string; raw: unknown; ms: number; ok: boolean; detail?: string }

  /**
   * Run this message's read-only tool calls concurrently, keyed by call id.
   * Returns empty when there is nothing to gain (zero or one call), so the
   * common path is unchanged.
   */
  const runReadOnlyCalls = async (
    toolCalls: ToolCall[],
  ): Promise<Map<string, Precomputed>> => {
    const out = new Map<string, Precomputed>()
    const readOnly = toolCalls.filter(tc => READ_ONLY_TOOLS.has(tc.function.name))
    if (readOnly.length < 2) return out

    for (const toolCall of readOnly) {
      const toolName = toolCall.function.name
      let callArgs: unknown
      try {
        callArgs = JSON.parse(toolCall.function.arguments)
      } catch {
        callArgs = undefined
      }
      emit({
        type: 'tool-start',
        agent,
        callId: toolCall.id,
        tool: toolName,
        summary: summarizeToolCall(toolName, callArgs, projectDir),
      })
    }

    const settled = await Promise.all(
      readOnly.map(async (toolCall): Promise<[string, Precomputed]> => {
        const started = Date.now()
        const toolName = toolCall.function.name
        const parsed = parseToolCall(toolCall)
        let content: string
        let raw: unknown
        if (!parsed.ok) {
          content = `Error: ${parsed.error}`
          raw = content
        } else if (parsed.call.tool === ('search_files' as ToolName)) {
          const args = parsed.call.args as { query: string }
          content = searchSummary(summaryIndex, args.query)
          raw = content
        } else {
          // A tool call can block for minutes; keep the row moving meanwhile.
          const stopHeartbeat = startHeartbeat(emit, agent)
          try {
            const result = await handle.callTool(parsed.call.tool, parsed.call.args)
            content = typeof result === 'string' ? result : JSON.stringify(result)
            raw = result
          } catch (e) {
            content = `Error: ${e instanceof Error ? e.message : String(e)}`
            raw = content
          } finally {
            stopHeartbeat()
          }
        }
        const ms = Date.now() - started
        const outcome = summarizeToolResult(
          parsed.ok ? parsed.call.tool : toolName,
          parsed.ok ? parsed.call.args : undefined,
          raw,
          ms,
        )
        return [toolCall.id, { content, raw, ms, ok: outcome.ok, detail: outcome.detail }]
      }),
    )
    for (const [id, value] of settled) out.set(id, value)
    return out
  }

  /**
   * One mutating (or single) tool call, end to end. Returns the content to
   * append as its result. Read-only calls arrive pre-computed from
   * `runReadOnlyCalls` and never reach here.
   */
  const runToolCall = async (toolCall: ToolCall, callStarted: number): Promise<string> => {
    const toolName = toolCall.function.name
    const parsed = parseToolCall(toolCall)
    let resultContent: string
    let rawResult: unknown = undefined

    if (!parsed.ok) {
      resultContent = `Error: ${parsed.error}`
      emitToolEnd(toolCall.id, toolName, false, callStarted, 'bad arguments')
      return resultContent
    }

    if (parsed.call.tool === ('search_files' as ToolName)) {
      const args = parsed.call.args as { query: string }
      resultContent = searchSummary(summaryIndex, args.query)
      rawResult = resultContent
    } else {
      // A tool call can block for minutes (run_command has a 30s+ timeout).
      // chat.ts heartbeats provider round-trips; this covers the tool itself,
      // otherwise the screen is still for exactly as long as the call.
      const stopHeartbeat = startHeartbeat(emit, agent)
      try {
        const result = await handle.callTool(parsed.call.tool, parsed.call.args)
        resultContent = typeof result === 'string' ? result : JSON.stringify(result)
        rawResult = result
        if (parsed.call.tool === 'read_file' && typeof result === 'string') {
          const readArgs = parsed.call.args as { path?: unknown }
          if (typeof readArgs.path === 'string') {
            filesRead.set(readArgs.path, result)
          }
        } else if (parsed.call.tool === 'run_baseline' && typeof result === 'string') {
          recordBaseline(result, parsed.call.args)
        }
      } catch (e) {
        resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
        rawResult = resultContent
      } finally {
        stopHeartbeat()
      }
    }

    const outcome = summarizeToolResult(
      parsed.call.tool,
      parsed.call.args,
      rawResult,
      Date.now() - callStarted,
    )
    emit({
      type: 'tool-end',
      agent,
      callId: toolCall.id,
      tool: parsed.call.tool,
      ok: outcome.ok,
      ms: Date.now() - callStarted,
      detail: outcome.detail,
    })
    return resultContent
  }

  // Evidence ledger (§4): harness-collected observations for this planning
  // turn. The model never supplies these values — it only triggers the calls
  // that produce them.
  const filesRead = new Map<string, string>()
  const baselinesByCommand = new Map<string, number>()

  /** Record the observed exit code of a run_baseline call. Harness rejections
   *  (disallowed command, cwd escape, timeout) arrive as negative exits and are
   *  not observations of the command itself, so they are not recorded. */
  const recordBaseline = (result: string, rawArgs: unknown): void => {
    try {
      const payload = JSON.parse(result) as { exitCode?: number }
      if (typeof payload.exitCode !== 'number' || payload.exitCode < 0) return
      const b = rawArgs as { command?: unknown; args?: unknown; cwd?: unknown }
      if (typeof b.command !== 'string') return
      baselinesByCommand.set(
        baselineKey(
          b.command,
          Array.isArray(b.args) ? b.args.map(String) : [],
          typeof b.cwd === 'string' ? b.cwd : undefined,
          projectDir,
        ),
        payload.exitCode,
      )
    } catch {
      // Not a C1 payload — nothing to record.
    }
  }

  if (messages.length === 0) {
    emit({ type: 'phase', agent, phase: 'indexing' })
    const { tree, summaryText } = buildInitialPromptContext(projectDir, summaryIndex, model)
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
  emit({ type: 'phase', agent, phase: 'planning' })

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
      {
        apiKey,
        model,
        messages: compressedMessages,
        tools: toolSpecs,
        signal,
        round: totalIterations,
        roundBudget: MAX_TOTAL_ITERATIONS,
        onEvent: event => emit({ ...event, agent }),
      },
      text => onTextDelta?.(text),
      thinking => onThinkingDelta?.(thinking),
    )

    if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
      const content = result.message.content ?? ''
      messages.push(result.message)
      return { type: 'response', response: content }
    }

    messages.push(result.message)

    /**
     * §2: read-only calls in one assistant message are independent — a model
     * routinely asks for 3-5 files at once. Run them together and hand the
     * results to the ordered loop below, so the tool-call chain is still
     * answered in the model's original order.
     */
    const precomputed = await runReadOnlyCalls(result.message.tool_calls)

    let planned: DeveloperTurnResult | null = null

    for (const toolCall of result.message.tool_calls) {
      if (planned) break
      const callStarted = Date.now()
      const toolName = toolCall.function.name
      let callArgs: unknown
      try {
        callArgs = JSON.parse(toolCall.function.arguments)
      } catch {
        callArgs = undefined
      }
      // A batched read-only call already announced itself before it ran.
      if (!precomputed.has(toolCall.id)) {
        const summary =
          toolName === 'propose_plan'
            ? summarizePlanTaskCount(callArgs)
            : summarizeToolCall(toolName, callArgs, projectDir)
        emit({
          type: 'tool-start',
          agent,
          callId: toolCall.id,
          tool: toolName,
          summary,
        })
      }

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
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'invalid JSON')
          continue
        }

        const proposed = proposePlanTool.schema.safeParse(parsed)
        if (!proposed.success) {
          const detail = proposed.error.issues
            .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
            .join('; ')
          messages.push({
            role: 'tool',
            content: `Error: propose_plan arguments were rejected: ${detail}. Fix them and call propose_plan again.`,
            tool_call_id: toolCall.id,
          })
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }

        const structured = hasStructuredFields(proposed.data.tasks)
        const rejection: string[] = []
        if (structured) {
          const evidence = buildEvidence(filesRead, baselinesByCommand, proposed.data.tasks, projectDir)
          const validation = validatePlan(proposed.data.tasks, evidence, projectDir)
          if (!validation.ok) rejection.push(...validation.errors)
        }
        const contractCheck = validateContracts(proposed.data.tasks, proposed.data.contracts)
        rejection.push(...contractCheck.errors)

        if (rejection.length > 0) {
          messages.push({
            role: 'tool',
            content: `Plan rejected:\n- ${rejection.join('\n- ')}`,
            tool_call_id: toolCall.id,
          })
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }

        const parsedPlan = parseProposePlanArgs(parsed, projectDir)
        if (!parsedPlan.ok) {
          messages.push({
            role: 'tool',
            content: `Error: ${parsedPlan.error}`,
            tool_call_id: toolCall.id,
          })
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }
        const plan = parsedPlan.plan
        if (!structured) {
          // Flat legacy plans still get file-level ordering inferred for them.
          // Structured plans declare their own dependsOn and were already
          // checked for write conflicts by planParallel.
          plan.tasks = addFileLevelDependencies(plan.tasks)
        }
        plan.tasks = detectAndRemoveCircularDeps(plan.tasks)
        enrichHarnessEvidence(plan.tasks, filesRead, baselinesByCommand, projectDir)
        const parallel = planParallel(plan.tasks, projectDir)
        if (parallel.errors.length > 0) {
          messages.push({
            role: 'tool',
            content: `Plan rejected:\n- ${parallel.errors.join('\n- ')}`,
            tool_call_id: toolCall.id,
          })
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }
        const warnings = [...parallel.warnings, ...contractCheck.warnings]
        messages.push({
          role: 'tool',
          content:
            warnings.length > 0
              ? `Plan proposed. Awaiting user review.\nPlan warnings:\n- ${warnings.join('\n- ')}`
              : 'Plan proposed. Awaiting user review.',
          tool_call_id: toolCall.id,
        })
        emitToolEnd(
          toolCall.id,
          toolName,
          true,
          callStarted,
          `${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}`,
        )
        planned = { type: 'plan', plan }
        continue
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
        emitToolEnd(toolCall.id, toolName, false, callStarted, 'budget exhausted')
        continue
      }

      const done = precomputed.get(toolCall.id)
      if (done) {
        // Already run in the read-only batch above; answer it in the model's
        // order without touching the handle a second time.
        if (toolName === 'read_file' && typeof done.raw === 'string') {
          let readArgs: unknown
          try {
            readArgs = JSON.parse(toolCall.function.arguments)
          } catch {
            readArgs = undefined
          }
          const path = (readArgs as { path?: unknown } | undefined)?.path
          if (typeof path === 'string') filesRead.set(path, done.raw)
        } else if (toolName === 'run_baseline') {
          let baseArgs: unknown
          try {
            baseArgs = JSON.parse(toolCall.function.arguments)
          } catch {
            baseArgs = undefined
          }
          recordBaseline(String(done.raw), baseArgs)
        }
        emit({
          type: 'tool-end',
          agent,
          callId: toolCall.id,
          tool: toolName,
          ok: done.ok,
          ms: done.ms,
          ...(done.detail === undefined ? {} : { detail: done.detail }),
        })
        messages.push({ role: 'tool', content: done.content, tool_call_id: toolCall.id })
        continue
      }

      const content = await runToolCall(toolCall, callStarted)
      messages.push({ role: 'tool', content, tool_call_id: toolCall.id })
    }

    if (planned) return planned
  }

  const fallbackContent = isInterrupted?.()
    ? 'Interrupted by user.'
    : 'I have enough context. Let me propose a plan.'
  messages.push({ role: 'assistant', content: fallbackContent })
  return { type: 'response', response: fallbackContent }
}
