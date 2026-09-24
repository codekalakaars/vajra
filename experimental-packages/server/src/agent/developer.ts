// Developer Agent — conversational planning.
//
// The developer runs in the main server process and makes LLM calls to
// understand the user's task through conversation. When it has enough
// context, it calls the `propose_plan` tool, which is intercepted here
// (never dispatched to the sandboxed worker) and returned as a
// DeveloperPlan for the user to review.
//
// File tools (read_file, list_files, search_files) are dispatched to the
// sandboxed worker via the LaunchHandle, same as the single-agent loop.

import type { SqliteDb } from '../db/client.js'
import { runInTransaction } from '../db/client.js'
import type { PushEvents, LaunchHandle } from '../project/manager.js'
import type { DeveloperPlan, PlannedTask, ToolName } from '@codekalakaars/vajra-protocol'
import type { ChatProvider, ChatMessage } from './providers/types.js'
import { getDeveloperToolSpecs, parseToolCall } from './tools.js'
import { projectContext } from './project-context.js'
import { buildSummaryIndex, formatSummaryIndexHierarchical, type SummaryEntry } from './summary.js'
import { compressMessages } from './context.js'
import { searchSummary, appendMessage, nextSeq } from './utils.js'
import { MAX_DEVELOPER_TOOL_CALLS, MAX_TASK_CONTEXT_SIZE, MAX_CONTEXT_LINES } from './constants.js'
import { componentLogger } from '../logger.js'
import { resolve, relative, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const log = componentLogger('developer')

const FREE_TOOLS = new Set(['search_files'])

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
    '- deleteFile: Files to delete',
    '- createDir: Directories to create',
    '- validation: Commands to run after completion (must exit 0 on success). IMPORTANT: Do NOT use commands that require a running server (npm test, curl localhost, etc.) unless the task explicitly starts the server. Use syntax checks (node --check, tsc --noEmit) or static analysis (eslint) instead.',
    '- dependsOn: Task IDs this depends on',
    '- type: create, modify, delete, or refactor',
    '- allowedTools: Tools this worker can use (optional, defaults to task-type defaults)',
    '- complexity: low, medium, or high (affects task sizing)',
    '- validationStrategy: hierarchical, incremental, or contextAware (optional)',
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
    'Validation Strategies:',
    '- hierarchical: Run unit tests first, then integration, then e2e (default)',
    '- incremental: Validate after each task completes',
    '- contextAware: Only validate files that changed in this task',
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

/**
 * Read relevant code context for a task.
 * Extracts relevant code snippets from files that the worker needs to read.
 */
async function readTaskContext(
  readFile: string[],
  writeFile: string[],
  instructions: string[],
  handle: LaunchHandle,
  fileCache: Map<string, string>,
): Promise<string> {
  // Combine all files that need to be read or written
  const allFiles = [...new Set([...readFile, ...writeFile])]

  // Reuse content already fetched during the Developer's exploration; only
  // fetch the ones that are missing, and fetch those concurrently instead
  // of one file at a time.
  const uncached = allFiles.filter((f) => !fileCache.has(f))
  await Promise.all(
    uncached.map(async (filePath) => {
      try {
        const result = await handle.callTool('read_file', { path: filePath })
        const content = typeof result === 'string' ? result : JSON.stringify(result)
        fileCache.set(filePath, content)
      } catch {
        // File might not exist yet (for writeFile targets) — leave uncached
      }
    }),
  )

  const contextParts: string[] = []
  let currentSize = 0

  for (const filePath of allFiles) {
    if (currentSize >= MAX_TASK_CONTEXT_SIZE) break

    const content = fileCache.get(filePath)
    if (content === undefined) continue

    // Extract relevant lines based on instructions
    const relevantLines = extractRelevantLines(content, instructions)

    if (relevantLines.length > 0) {
      const snippet = `\n--- ${filePath} ---\n${relevantLines}\n--- end ${filePath} ---`
      contextParts.push(snippet)
      currentSize += snippet.length
    }
  }

  return contextParts.join('\n')
}

/**
 * Extract relevant lines from a file based on instructions.
 * Anchors on symbol definitions (function, class, const, let, var declarations)
 * rather than bare substring occurrences, and extracts the enclosing block.
 * Falls back to line-number ranges or the head of the file.
 */
function extractRelevantLines(content: string, instructions: string[]): string {
  const lines = content.split('\n')
  const relevantLineNumbers = new Set<number>()

  // 1. Extract explicit line-number references ("line 42", "lines 10-20")
  for (const instruction of instructions) {
    const lineMatches = instruction.match(/lines?\s+(\d+)(?:\s*-\s*(\d+))?/gi)
    if (lineMatches) {
      for (const match of lineMatches) {
        const nums = match.match(/\d+/g)
        if (nums) {
          const start = parseInt(nums[0]) - 1
          const end = nums.length > 1 ? parseInt(nums[1]) - 1 : start
          for (let i = start; i <= end && i < lines.length; i++) {
            relevantLineNumbers.add(i)
          }
        }
      }
    }
  }

  // 2. Extract symbol names from instructions and find their definitions.
  //    A definition is a line that declares the symbol (not merely references it).
  const symbolPatterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/g,
    /(?:export\s+)?(?:default\s+)?(?:function|class)\s+(\w+)/g,
  ]

  for (const instruction of instructions) {
    // Collect symbol names mentioned in this instruction
    const symbolNames = new Set<string>()
    for (const pattern of symbolPatterns) {
      const regex = new RegExp(pattern.source, 'g')
      let match
      while ((match = regex.exec(instruction)) !== null) {
        symbolNames.add(match[1])
      }
    }

    for (const name of symbolNames) {
      // Find the definition line — anchored on a declaration keyword
      const defRegex = new RegExp(
        `^(?:export\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:default\\s+)?` +
        `(?:function|class|const|let|var)\\s+${name}\\b`,
      )
      for (let i = 0; i < lines.length; i++) {
        if (defRegex.test(lines[i])) {
          // Extract the enclosing block by counting braces
          let braceDepth = 0
          let foundOpen = false
          let blockEnd = i
          for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
              if (ch === '{') { braceDepth++; foundOpen = true }
              if (ch === '}') braceDepth--
            }
            if (foundOpen && braceDepth === 0) {
              blockEnd = j
              break
            }
          }
          for (let j = i; j <= blockEnd; j++) {
            relevantLineNumbers.add(j)
          }
          break
        }
      }
    }
  }

  // 3. Nothing matched → return the head of the file as context.
  if (relevantLineNumbers.size === 0) {
    return lines.slice(0, MAX_CONTEXT_LINES).join('\n')
  }

  // Sort and return relevant lines with context
  const sortedLines = [...relevantLineNumbers].sort((a, b) => a - b)
  const result: string[] = []
  let lastLine = -1

  for (const lineNum of sortedLines) {
    if (lastLine !== -1 && lineNum > lastLine + 1) {
      result.push('...')
    }
    result.push(`${lineNum + 1}: ${lines[lineNum]}`)
    lastLine = lineNum
  }

  return result.join('\n')
}

const execFileAsync = promisify(execFile)

interface PlanWarning {
  type: 'path_traversal' | 'command_not_found' | 'cycle_removed'
  message: string
}

async function validatePlan(
  plan: DeveloperPlan,
  projectDir: string,
): Promise<PlanWarning[]> {
  const warnings: PlanWarning[] = []
  const projectRoot = resolve(projectDir)

  // Check all file paths stay inside the project root
  for (const task of plan.tasks) {
    for (const filePath of [...task.readFile, ...task.writeFile, ...task.deleteFile]) {
      const full = isAbsolute(filePath) ? resolve(filePath) : resolve(projectDir, filePath)
      const rel = relative(projectRoot, full)
      if (rel.startsWith('..') || rel === '') {
        warnings.push({
          type: 'path_traversal',
          message: `Task "${task.title}" references "${filePath}" which is outside the project root`,
        })
      }
    }
  }

  // Check validation commands exist on PATH
  for (const task of plan.tasks) {
    for (const cmd of task.validation) {
      // Extract the base command (first word)
      const baseCmd = cmd.trim().split(/\s+/)[0]
      if (!baseCmd) continue
      try {
        await execFileAsync('which', [baseCmd])
      } catch {
        warnings.push({
          type: 'command_not_found',
          message: `Task "${task.title}" validation command "${baseCmd}" not found on PATH`,
        })
      }
    }
  }

  return warnings
}

export function parseProposePlanArgs(raw: unknown): DeveloperPlan {
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
      complexity?: string
      validationStrategy?: string
      alternativeApproaches?: string[]
    }>
    summary: string
  }

  let tasks: PlannedTask[] = args.tasks.map((t, i) => ({
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
    complexity: (['low', 'medium', 'high'].includes(t.complexity ?? '') ? t.complexity : 'medium') as 'low' | 'medium' | 'high',
    validationStrategy: (['hierarchical', 'incremental', 'contextAware'].includes(t.validationStrategy ?? '') ? t.validationStrategy : 'hierarchical') as 'hierarchical' | 'incremental' | 'contextAware',
    alternativeApproaches: t.alternativeApproaches ?? [],
  }))

  // Validate dependency references exist
  const taskIds = new Set(tasks.map((t) => t.id))
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter((dep) => taskIds.has(dep))
  }

  // Add file-level dependencies (tasks that write to files read by other
  // tasks), then break any cycle. The order matters: the inferred file-level
  // edges can themselves close a cycle, so removing cycles first leaves them
  // in the graph, where they strand every task involved as permanently
  // un-ready.
  tasks = addFileLevelDependencies(tasks)
  tasks = detectAndRemoveCircularDeps(tasks)

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

  // Optimize task ordering for parallelism
  const optimizedTasks = optimizeTaskOrder(tasks, independentGroups)

  return {
    tasks: optimizedTasks,
    independentGroups,
    estimatedWorkers: Math.max(1, ...independentGroups.map((g) => g.length)),
  }
}

/**
 * Break dependency cycles with a depth-first search.
 *
 * Only the edge that closes a cycle is dropped — the other dependencies of
 * the tasks involved still encode real ordering and are left alone.
 */
function detectAndRemoveCircularDeps(tasks: PlannedTask[]): PlannedTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const visited = new Set<string>()
  const onStack = new Set<string>()
  const removed: string[] = []

  function visit(taskId: string): void {
    if (visited.has(taskId)) return
    visited.add(taskId)
    onStack.add(taskId)

    const task = taskMap.get(taskId)
    if (task) {
      const kept: string[] = []
      for (const dep of task.dependsOn) {
        if (onStack.has(dep)) {
          // Back edge — following it would close a cycle.
          removed.push(`${taskId} -> ${dep}`)
          continue
        }
        visit(dep)
        kept.push(dep)
      }
      task.dependsOn = kept
    }

    onStack.delete(taskId)
  }

  for (const task of tasks) {
    visit(task.id)
  }

  if (removed.length > 0) {
    log.warn({ edges: removed }, 'Removed circular task dependencies')
  }

  return tasks
}

/**
 * Add file-level dependencies based on file access patterns.
 * If task A writes to a file that task B reads, B should depend on A.
 */
function addFileLevelDependencies(tasks: PlannedTask[]): PlannedTask[] {
  const planOrder = new Map(tasks.map((t, i) => [t.id, i]))

  for (const task of tasks) {
    for (const other of tasks) {
      if (task.id === other.id) continue
      if (task.dependsOn.includes(other.id)) continue

      // The other task produces a file this one reads: read after write.
      const producesInput = other.writeFile.some(file => task.readFile.includes(file))

      // Both write the same file, so they cannot run in parallel. Serialize
      // them in plan order: adding the edge in both directions — as this
      // once did — builds a cycle neither task can ever become ready from.
      const sharesOutput =
        other.writeFile.some(file => task.writeFile.includes(file)) &&
        (planOrder.get(other.id) ?? 0) < (planOrder.get(task.id) ?? 0)

      if (producesInput || sharesOutput) {
        task.dependsOn.push(other.id)
      }
    }
  }

  return tasks
}

/**
 * Optimize task order for better parallelism.
 * Reorders tasks within groups to maximize parallel execution.
 */
function optimizeTaskOrder(tasks: PlannedTask[], independentGroups: string[][]): PlannedTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const optimized: PlannedTask[] = []

  for (const group of independentGroups) {
    // Sort tasks within group by complexity (low first for quick wins)
    const groupTasks = group
      .map(id => taskMap.get(id)!)
      .sort((a, b) => {
        const complexityOrder = { low: 0, medium: 1, high: 2 }
        return (complexityOrder[a.complexity ?? 'medium'] ?? 1) - (complexityOrder[b.complexity ?? 'medium'] ?? 1)
      })

    optimized.push(...groupTasks)
  }

  return optimized
}

// ---- Public API ----

export interface DeveloperTurnInput {
  projectId: string
  projectDir: string
  userMessage: string
  model: string
  apiKey: string
  provider: ChatProvider
  events: PushEvents
  db: SqliteDb
  handle: LaunchHandle
  /** Accumulated conversation history. Mutated in place. */
  messages: ChatMessage[]
  /** Summary index for in-memory search. Built on first turn. */
  summaryIndex: SummaryEntry[]
  /** Cache of file contents already read during this conversation. Mutated in place. */
  fileCache: Map<string, string>
}

export type DeveloperTurnResult =
  | { type: 'response'; response: string }
  | { type: 'plan'; plan: DeveloperPlan }

/**
 * Run one turn of the Developer's conversation.
 *
 * On the first call, builds the system prompt with project context.
 * Subsequent calls reuse the existing conversation history.
 *
 * Returns either a text response (Developer is still gathering context) or
 * a DeveloperPlan (Developer called propose_plan).
 */
export async function developerConversationTurn(
  input: DeveloperTurnInput,
): Promise<DeveloperTurnResult> {
  const { projectId, projectDir, userMessage, model, apiKey, provider, events, db, handle, messages, summaryIndex, fileCache } = input

  // First turn: build system prompt and project context
  if (messages.length === 0) {
    const context = await projectContext(projectDir)
    const tree = context.tree
    if (summaryIndex.length === 0) {
      summaryIndex.push(...context.summaryIndex)
    }

    const summaryText = formatSummaryIndexHierarchical(summaryIndex)
    messages.push({
      role: 'system',
      content: buildDeveloperConversationPrompt(projectDir, tree, summaryText),
    })
  }

  // Persist user message
  runInTransaction(db, () => {
    const userSeq = nextSeq(db, projectId)
    appendMessage(db, projectId, userSeq, 'user', userMessage)
  })

  // Add user message to conversation
  messages.push({ role: 'user', content: userMessage })

  const providerType = provider.name === 'anthropic' ? 'anthropic' : 'openai'
  const toolSpecs = getDeveloperToolSpecs(providerType)
  let toolCallCount = 0

  // Tool-use loop (Developer may call read_file/list_files/search_files before proposing)
  while (toolCallCount < MAX_DEVELOPER_TOOL_CALLS) {
    // Compress for the request only. The full history stays in `messages`:
    // overwriting it with the compressed view discards context permanently and
    // makes every later turn compress an already-lossy transcript.
    const compressedMessages = compressMessages(messages, model)

    const result = await provider.streamChat(
      { apiKey, model, messages: compressedMessages, tools: toolSpecs },
      (text) => events.push('projects.assistantDelta', projectId, { text }),
      (thinking) => events.push('projects.thinkingDelta', projectId, { text: thinking }),
    )

    // No tool calls — text response to user
    if (!result.message.toolCalls || result.message.toolCalls.length === 0) {
      const content = result.message.content ?? ''
      runInTransaction(db, () => {
        const seq = nextSeq(db, projectId)
        appendMessage(db, projectId, seq, 'assistant', content)
      })
      messages.push(result.message)
      return { type: 'response', response: content }
    }

    // Has tool calls — process them
    messages.push(result.message)

    // propose_plan ends the turn immediately (never dispatched to the worker),
    // so any tool calls before it in this batch are the only ones that need
    // dispatching — run those concurrently instead of one at a time.
    const planIndex = result.message.toolCalls.findIndex((tc) => tc.name === 'propose_plan')
    const dispatchCalls = planIndex === -1 ? result.message.toolCalls : result.message.toolCalls.slice(0, planIndex)

    const dispatchResults = await Promise.all(
      dispatchCalls.map(async (toolCall) => {
        const isFree = FREE_TOOLS.has(toolCall.name)
        if (!isFree) {
          toolCallCount++
          if (toolCallCount > MAX_DEVELOPER_TOOL_CALLS) return null
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
            const callResult = await handle.callTool(parsed.call.tool, parsed.call.args)
            resultContent = typeof callResult === 'string' ? callResult : JSON.stringify(callResult)
            // Cache read_file results so plan-time context gathering doesn't re-read
            if (parsed.call.tool === ('read_file' as ToolName)) {
              const args = parsed.call.args as { path: string }
              fileCache.set(args.path, resultContent)
            }
          } catch (e) {
            resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        }

        return { role: 'tool' as const, content: resultContent, toolCallId: toolCall.id }
      }),
    )

    for (const toolResult of dispatchResults) {
      if (toolResult) messages.push(toolResult)
    }

    if (planIndex !== -1) {
      const toolCall = result.message.toolCalls[planIndex]
      let parsed: unknown
      try {
        parsed = JSON.parse(toolCall.arguments)
      } catch {
        // Bad JSON — tell the LLM and let it retry on the next loop iteration
        messages.push({
          role: 'tool',
          content: 'Error: propose_plan arguments were not valid JSON. Please try again.',
          toolCallId: toolCall.id,
        })
        continue
      }

      const plan = parseProposePlanArgs(parsed)

      // Validate plan: check path boundaries and command existence
      const warnings = await validatePlan(plan, projectDir)
      for (const w of warnings) {
        log.warn(`Plan warning: ${w.message}`)
      }

      // Close out the tool call before returning. The assistant message holding
      // this tool_call is already in history, and providers reject a
      // conversation where a tool call has no matching result — without this,
      // the next user turn (rejecting the plan and giving feedback) fails.
      const warningText = warnings.length > 0
        ? `\n\nWarnings:\n${warnings.map((w) => `- ${w.message}`).join('\n')}`
        : ''
      messages.push({
        role: 'tool',
        content: `Plan proposed. Awaiting user review.${warningText}`,
        toolCallId: toolCall.id,
      })

      // Inject relevant code context into task instructions
      events.push('projects.workerProgress', projectId, {
        agentId: 'developer',
        taskId: 'master',
        detail: 'Injecting code context into task instructions...',
      })

      // Tasks are independent for context-gathering purposes; the shared
      // fileCache dedupes overlapping reads across tasks, so fetch concurrently.
      await Promise.all(
        plan.tasks.map(async (task) => {
          const context = await readTaskContext(
            task.readFile,
            task.writeFile,
            task.instructions,
            handle,
            fileCache,
          )

          if (context) {
            // Add context to the beginning of instructions
            task.instructions = [
              `RELEVANT CODE CONTEXT:\n${context}`,
              '',
              'INSTRUCTIONS:',
              ...task.instructions,
            ]
          }
        }),
      )

      // Emit plan events
      events.push('projects.planStarted', projectId, {})
      for (const t of plan.tasks) {
        events.push('projects.planTask', projectId, { task: t })
      }
      events.push('projects.planComplete', projectId, { plan })

      // Persist the plan as the final assistant message
      runInTransaction(db, () => {
        const planSeq = nextSeq(db, projectId)
        appendMessage(db, projectId, planSeq, 'assistant', JSON.stringify(plan))
      })

      return { type: 'plan', plan }
    }
  }

  // Exceeded tool budget — force a response
  const fallbackContent = 'I have enough context. Let me propose a plan.'
  messages.push({ role: 'assistant', content: fallbackContent })
  return { type: 'response', response: fallbackContent }
}
