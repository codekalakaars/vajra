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
import { streamChatCompletion, type ChatMessage, type ReasoningEffort, type ToolCall } from './chat.js'
import { getModelLimit } from './context-window.js'
import { getDeveloperToolSpecs, parseToolCall } from './tools.js'
import { tokenizeCommand } from '../tools/handle.js'
import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, formatSummaryIndexHierarchical, renderSummaryIndex, searchSummary, type SummaryEntry } from './summary.js'
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
    '- read_file(path): read a file to understand the codebase. For a large file pass offset/limit (1-based lines) or symbols (declaration names) — an edit anchor must be copied from text this call actually returned',
    '- list_files(path): list directory contents',
    '- run_baseline(command, args, cwd): run a candidate verify command BEFORE any changes, to record whether it currently passes',
    '- write_stub(path, content): create a NEW file that does not exist yet — Phase One scaffolding, so you can write and run a test against a real module. It refuses to touch an existing file',
    '- delete_stub(path): remove a file write_stub created this session, and nothing else',
    '- propose_plan(tasks, summary): propose a detailed plan when ready',
    '',
    'IMPORTANT RULES:',
    '- Do NOT call propose_plan on the first message — read files first to understand the codebase',
    '- If the user provides specific requirements (validation rules, file names, libraries to use), skip ALL clarifying questions and go directly to propose_plan',
    '- Only ask clarifying questions if the task is extremely vague (e.g., "fix the bug" with no context)',
    '- NEVER ask more than 2 clarifying questions — prefer making reasonable defaults',
    '- Only read files you need to understand the task',
    '- Tasks must be HIGHLY PRESCRIPTIVE — the worker should not need to think',
    '- Every plan opens with Phase One: stub tasks, then test tasks, then the work itself',
    '',
    'When calling propose_plan, EVERY task uses this shape:',
    '',
    '- id: short kebab-case id, unique in the plan (e.g. "todo-clobber")',
    '- title: Short title',
    '- description: What needs to be done and why',
    '- type: create, modify, delete, or refactor',
    '- dependsOn: task ids that must finish first (empty only when the task is independent)',
    '- context: [{path, reason}] — files to read AND why, one line of reason each',
    '- edits: [{op, path, anchor, change}] — the edits themselves, one entry per site',
    '    · op "create" needs no anchor; op "modify" and "delete" MUST quote the anchor',
    '- verify: [{command, args, cwd, kind}] — how to prove it works',
    '    · kind "proves-change" must FAIL now and pass after the task',
    '    · kind "regression-guard" must pass now and keep passing',
    '',
    'PLAN STRUCTURE — every plan opens with Phase One, in this order:',
    '',
    '1. STUB TASKS. One per file the work will touch. Writing the minimal valid',
    '   file: imports resolved, the symbols the rest of the work will reference',
    '   exported, behaviour empty. Nothing can come first, because a test cannot',
    '   be written against a file that does not exist.',
    '',
    '   To get the stub in front of you before the plan exists, create it with',
    '   write_stub. That is what lets you write the test in step 2 against',
    '   something real, and run_baseline it to see it fail. Because the file then',
    '   exists, the task edit for it must be op "modify" with an anchor from its',
    '   contents — op "create" will be refused. If you would rather the Worker',
    '   create it, do not call write_stub and use op "create" as shown below.',
    '2. TEST TASKS. One per behaviour. Write a test that runs against its stub and',
    '   fails right now, because the behaviour is not implemented yet. Its verify',
    '   checks that the test file itself is valid — NOT that the suite passes. A test',
    '   that already passed would mean the behaviour is already implemented.',
    '3. IMPLEMENTATION TASKS. Make those failing tests pass.',
    '',
    'Wire the order with dependsOn: each test task depends on the stub for the file',
    'it tests, and each implementation task depends on the test it satisfies. Every',
    'task is still a normal task — nothing marks them as groundwork except their',
    'position and what their verify checks.',
    '',
    'WRITTEN EXAMPLE — the shape that passes, with Phase One first:',
    '',
    '{',
    '  "summary": "Stop setTodos from dropping a just-added todo",',
    '  "tasks": [',
    '    {',
    '      "id": "todo-stub",',
    '      "title": "Create src/state/todo.ts",',
    '      "description": "Minimal valid module: the Todo type, the initial state, and an exported setTodos. No behaviour yet.",',
    '      "type": "create",',
    '      "dependsOn": [],',
    '      "edits": [{',
    '        "op": "create",',
    '        "path": "src/state/todo.ts",',
    '        "change": "export type Todo = { id: string; text: string }; export const initialTodos: Todo[] = []; export function setTodos(next: Todo[]): void {}"',
    '      }],',
    '      "verify": [{ "command": "node", "args": ["--check", "src/state/todo.ts"], "kind": "proves-change" }]',
    '    },',
    '    {',
    '      "id": "todo-clobber-test",',
    '      "title": "Test that addTodo does not drop the new todo",',
    '      "description": "A todo added in the same tick as the sync effect must survive it.",',
    '      "type": "create",',
    '      "dependsOn": ["todo-stub"],',
    '      "edits": [{',
    '        "op": "create",',
    '        "path": "src/state/todo.test.ts",',
    '        "change": "node:test test that calls addTodo then the sync effect and asserts the todo is still present"',
    '      }],',
    '      "verify": [{ "command": "node", "args": ["--check", "src/state/todo.test.ts"], "kind": "proves-change" }]',
    '    },',
    '    {',
    '      "id": "todo-clobber",',
    '      "title": "Make addTodo use the functional updater",',
    '      "description": "addTodo calls setTodos([...todos, t]) and the effect then calls setTodos(todos), so the new todo is lost on the next render.",',
    '      "type": "modify",',
    '      "dependsOn": ["todo-clobber-test"],',
    '      "context": [',
    '        { "path": "src/state/todo.ts", "reason": "addTodo and the sync effect that clobbers it" }',
    '      ],',
    '      "edits": [{',
    '        "op": "modify",',
    '        "path": "src/state/todo.ts",',
    '        "anchor": "  const addTodo = (t: Todo) => setTodos([...todos, t])",',
    '        "change": "append the new todo to the previous state instead: setTodos(prev => [...prev, t])"',
    '      }],',
    '      "verify": [{ "command": "node", "args": ["--test", "src/state/todo.test.ts"], "kind": "proves-change" }]',
    '    }',
    '  ]',
    '}',
    '',
    'Do NOT add fields the harness ignores. Omit complexity, validationStrategy,',
    'estimatedDuration, alternativeApproaches and allowedTools unless the user asked',
    'for something specific. rollback and timeoutSeconds are only worth setting when a',
    'task is genuinely risky or slow.',
    '',
    'CRITICAL: each edits[].change must be specific enough that a worker with no',
    'context can execute it. Name the file, the function and the behaviour.',
    'Bad: "Add error handling to the API"',
    'Good: "In src/api/users.ts, wrap the db.query() call in try-catch; in the catch ' +
      'return { status: 500, error: e.message }, importing HttpError from src/utils/errors.ts."',
    '',
    'SIZING: 2-4 units of work. Phase One adds a stub and a test task per unit, so',
    'that is roughly 6-12 tasks; 12 is the hard limit. Above that the plan is',
    'rejected: the work is one concern per task, and a task that needs a list of',
    'unrelated verbs is two tasks. Keep related edits to one file in one task; split',
    'across files only when they genuinely do not depend on each other. If the work',
    'really is larger, plan the first slice and leave the rest for the user.',
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
    '',
    '7. PHASE ONE IS NOT OPTIONAL. No implementation task may come first. Every plan',
    '   starts with the stub for each file it touches, then the test for each',
    '   behaviour, then the implementation — and each depends on the one before it.',
    '   An implementation-first plan has no mechanical definition of "done": nothing',
    '   in it fails before the work and passes after.',
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

/**
 * Which task shape a task is written in.
 *
 * `structured` is the only shape a plan may use: context/edits/verify are the
 * fields the validator can actually check (a file was really read, an anchor
 * really appears, a baseline really failed). `flat` and `empty` declare no
 * target files and no success criteria, so nothing about them can be verified —
 * they are reported here so the dispatcher can reject them with an
 * explanation. A plan that mixes shapes gets half its tasks verified and half
 * skipped, so it is rejected and named rather than silently lowered.
 */
function taskShape(task: PlannedTaskInput): 'structured' | 'flat' | 'empty' {
  if ((task.edits?.length ?? 0) > 0 || (task.context?.length ?? 0) > 0 || (task.verify?.length ?? 0) > 0) {
    return 'structured'
  }
  if (
    (task.instructions?.length ?? 0) > 0 ||
    (task.readFile?.length ?? 0) > 0 ||
    (task.writeFile?.length ?? 0) > 0
  ) {
    return 'flat'
  }
  return 'empty'
}

const q = (s: string): string => `'${s}'`

/** Hard ceiling on one plan, enforced rather than merely suggested. */
export const MAX_PLAN_TASKS = 12

/**
 * Feed a rejection back to the model, and make the attempt count visible.
 *
 * The validator's messages already say what to fix; what was missing was any
 * sense of repetition. A model that has been rejected three times keeps
 * re-proposing the same plan shape, so the third rejection is where telling it
 * to change strategy — narrow the scope, or ask — saves more time than
 * another round of errors.
 *
 * `measured` is the other half. A verify entry's `kind` is decided by the exit
 * code the Developer already recorded for it, and a rejection that says only
 * "already passes before any change" sends it back to `run_baseline` to find
 * out what it already measured — which in a real session was twenty-six
 * baseline runs across four proposals, twenty-five of them distinct commands,
 * because every rejection restarted the measurement from nothing.
 */
function rejectPlan(
  messages: ChatMessage[],
  toolCallId: string,
  errors: readonly string[],
  attempt = 1,
  measured: readonly string[] = [],
): void {
  const header = attempt >= 3
    ? `Plan rejected (attempt ${attempt}). Re-reading these will not help — change approach: ` +
      'propose a smaller plan for the part you are sure about, or ask the user a specific question.'
    : attempt === 2
      ? `Plan rejected (attempt 2). Fix every point below in the next call:`
      : 'Plan rejected:'
  const body = `${header}\n- ${errors.join('\n- ')}`
  messages.push({
    role: 'tool',
    content:
      measured.length === 0
        ? body
        : `${body}\n\nYou already measured these. The kind follows the exit code — do not re-run them:\n${measured.join('\n')}`,
    tool_call_id: toolCallId,
  })
}

/**
 * The exit codes already recorded for the commands in a rejected plan, with the
 * kind each one has to carry.
 *
 * This is the decision the model was getting wrong, restated with the numbers it
 * had already collected: `proves-change` needs an exit that is not the expected
 * one, `regression-guard` needs the expected one. Only the commands in the plan
 * are listed, and only the ones with an observation, so it is short enough to
 * read and complete enough to act on.
 */
export function measuredBaselines(
  tasks: readonly PlannedTaskInput[],
  baselinesByCommand: ReadonlyMap<string, number>,
  projectDir: string,
): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const task of tasks) {
    for (const v of task.verify ?? []) {
      const key = baselineKey(v.command, v.args ?? [], v.cwd, projectDir)
      if (seen.has(key)) continue
      seen.add(key)
      const exit = baselinesByCommand.get(key)
      if (exit === undefined) continue
      const expected = v.expectExit ?? 0
      const kind = exit === expected ? 'regression-guard' : 'proves-change'
      // Not labelled by task: the same command in two tasks needs one kind
      // decision, and repeating it per task is how a plan ends up labelling the
      // same command two different ways.
      lines.push(`  exit ${exit}  ${v.command} ${(v.args ?? []).join(' ')}  → kind ${kind}`)
    }
  }
  return lines
}

/** The plan-wide shape decision, with the offenders named for the error. */
export function planShape(tasks: readonly PlannedTaskInput[]): {
  kind: 'structured' | 'flat' | 'mixed' | 'empty'
  offenders?: string
} {
  let structured: string[] = []
  let flat: string[] = []
  for (const task of tasks) {
    const shape = taskShape(task)
    if (shape === 'structured') structured.push(task.title)
    else if (shape === 'flat') flat.push(task.title)
  }
  if (structured.length > 0 && flat.length > 0) {
    return {
      kind: 'mixed',
      offenders: `context/edits/verify: ${structured.slice(0, 3).map(q).join(', ')}; flat: ${flat
        .slice(0, 3)
        .map(q)
        .join(', ')}`,
    }
  }
  if (structured.length > 0) return { kind: 'structured' }
  if (flat.length > 0) return { kind: 'flat' }
  return { kind: 'empty' }
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
  /**
   * How much of the staged index actually reached the prompt.
   *
   * `summaryIndex` can be larger than the budget can render — a repository that
   * outgrows the cap is trimmed silently, and the Developer then reasons about a
   * project it cannot see. These make that condition observable instead.
   */
  summaryShown: number
  summaryTotal: number
  summaryTruncated: boolean
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

  const render = renderSummaryIndex(summaryIndex, summaryBudget)
  const summaryText = render.text

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

  return {
    tree,
    summaryText,
    summaryBudget,
    summaryShown: render.shown,
    summaryTotal: render.total,
    summaryTruncated: render.truncated,
  }
}

/**
 * Harness-collected evidence for plan validation, carried across the turns of
 * one planning conversation.
 *
 * `filesRead` maps a path to the content the model actually read, which is what
 * lets the validator reject a plan that cites a file nobody opened and check an
 * edit's anchor against real text. `baselinesByCommand` is keyed the way
 * `baselineKey` spells a command, holding the exit code observed before any
 * change.
 *
 * The caller owns the lifetime and must call `resetEvidenceLedger` before any
 * phase that writes to the project: once Workers have edited files, the
 * recorded content is stale and an anchor would be validated against text that
 * no longer exists.
 */
export interface PlanEvidenceLedger {
  filesRead: Map<string, string>
  baselinesByCommand: Map<string, number>
}

export function createEvidenceLedger(): PlanEvidenceLedger {
  return { filesRead: new Map(), baselinesByCommand: new Map() }
}

/**
 * Drop everything. Called at the execution boundary, not between turns: within
 * planning nothing writes, so observations stay true, but the moment a plan is
 * confirmed the Workers start changing the files the evidence describes.
 */
export function resetEvidenceLedger(evidence: PlanEvidenceLedger): void {
  evidence.filesRead.clear()
  evidence.baselinesByCommand.clear()
}

export interface DeveloperTurnInput {
  sessionId: string
  projectDir: string
  userMessage: string
  model: string
  apiKey: string
  /** Omitted from the wire when 'off'. */
  reasoningEffort?: ReasoningEffort
  handle: LaunchHandle
  messages: ChatMessage[]
  summaryIndex: SummaryEntry[]
  /**
   * Evidence carried between turns of one planning conversation. Omit it and
   * the turn keeps its own, which cannot survive a rejected plan.
   */
  evidence?: PlanEvidenceLedger
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
  const { sessionId, projectDir, userMessage, model, apiKey, reasoningEffort, handle, messages, summaryIndex, onTextDelta, onThinkingDelta, isInterrupted, signal, onAgentEvent } = input

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
        } else if (parsed.call.tool === 'write_stub') {
          // A stub the Developer just wrote is evidence, not just a side effect.
          // Without this the plan could not `modify` its own stub — it would be
          // told it never read the file — even though the Developer authored
          // every byte of it. It also means `op: 'create'` on that path is
          // correctly refused, because the file now genuinely exists.
          const stubArgs = parsed.call.args as { path?: unknown; content?: unknown }
          if (typeof stubArgs.path === 'string' && typeof stubArgs.content === 'string') {
            filesRead.set(stubArgs.path, stubArgs.content)
          }
        } else if (parsed.call.tool === 'delete_stub') {
          // The stub is gone, so it must stop counting as available: a plan that
          // still cited it would be validated against a file that no longer
          // exists.
          const stubArgs = parsed.call.args as { path?: unknown }
          if (typeof stubArgs.path === 'string') filesRead.delete(stubArgs.path)
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

  // Evidence ledger (§4): harness-collected observations for planning. The
  // model never supplies these values — it only triggers the calls that produce
  // them. The caller owns it so a plan rejected in one turn can be re-proposed
  // in the next without re-reading and re-baselining everything: without that,
  // the rejection feedback ("you never read it", "was never run") is
  // unsatisfiable, because the evidence it demands died with the turn.
  const evidence = input.evidence ?? createEvidenceLedger()
  const { filesRead, baselinesByCommand } = evidence
  /** Consecutive rejected plans, so the feedback can escalate. */
  let planRejections = 0

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
    if (compressedMessages.length < messages.length) {
      emit({
        type: 'warning',
        agent,
        text: `Context compacted: ${messages.length - compressedMessages.length} message(s) dropped to fit the ${getModelLimit(model).toLocaleString('en-US')}-token window`,
      })
    }

    const result = await streamChatCompletion(
      {
        apiKey,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
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

        // One shape per plan. A plan that mixes them would have half its tasks
        // checked for real anchors and read files, and half skipped — worse
        // than either, because the unchecked half still runs.
        const shape = planShape(proposed.data.tasks)
        if (shape.kind === 'mixed') {
          planRejections += 1
          rejectPlan(messages, toolCall.id, [
            `Tasks use two different shapes (${shape.offenders}). Every task in a plan ` +
              'must use the same one. Convert the flat tasks to context/edits/verify.',
          ], planRejections)
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }
        if (proposed.data.tasks.length > MAX_PLAN_TASKS) {
          planRejections += 1
          rejectPlan(messages, toolCall.id, [
            `Plan has ${proposed.data.tasks.length} tasks; the limit is ${MAX_PLAN_TASKS}. ` +
              'Consolidate: one concern per task, and merge edits to the same file into ' +
              'a single task. If the work really is that large, plan the first slice and ' +
              'leave the rest for the user to schedule.',
          ], planRejections)
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }

        const rejection: string[] = []
        if (shape.kind !== 'structured') {
          // context/edits/verify are the only fields the harness can check: that
          // a cited file was really read, that an anchor really appears once,
          // that a baseline really failed. A flat or empty task declares no
          // target files and no success criteria, so there is nothing to check
          // its claims against — and nothing tells the Worker what it must
          // produce or how anyone will know it worked. Reject rather than accept
          // a plan that was never verified, however convenient its shape.
          rejection.push(
            'Every task must be built from context/edits/verify. A task made only ' +
              'of instructions/readFile/writeFile — or of none of those — declares no ' +
              'target files and no success criteria, so nothing about it can be ' +
              'verified and a Worker has nothing to execute against. Give each task: ' +
              'context (the files to read, each with a reason), edits (every change, ' +
              'with a verbatim anchor for each modify), and verify (a command that ' +
              'fails now and passes once the task is done).',
          )
        }

        const evidence = buildEvidence(filesRead, baselinesByCommand, proposed.data.tasks, projectDir)
        const validation = validatePlan(proposed.data.tasks, evidence, projectDir)
        if (!validation.ok) rejection.push(...validation.errors)
        const contractCheck = validateContracts(proposed.data.tasks, proposed.data.contracts)
        rejection.push(...contractCheck.errors)

        if (rejection.length > 0) {
          planRejections += 1
          rejectPlan(
            messages,
            toolCall.id,
            rejection,
            planRejections,
            measuredBaselines(proposed.data.tasks, baselinesByCommand, projectDir),
          )
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }

        const parsedPlan = parseProposePlanArgs(parsed, projectDir)
        if (!parsedPlan.ok) {
          planRejections += 1
          rejectPlan(messages, toolCall.id, [parsedPlan.error], planRejections)
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }
        const plan = parsedPlan.plan
        enrichHarnessEvidence(plan.tasks, filesRead, baselinesByCommand, projectDir)
        const parallel = planParallel(plan.tasks, projectDir)
        if (parallel.errors.length > 0) {
          planRejections += 1
          rejectPlan(messages, toolCall.id, parallel.errors, planRejections)
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }
        planRejections = 0
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
