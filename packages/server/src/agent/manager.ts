// Manager Agent — conversational planning.
//
// The manager runs in the main server process and makes LLM calls to
// understand the user's task through conversation. When it has enough
// context, it calls the `propose_plan` tool, which is intercepted here
// (never dispatched to the sandboxed worker) and returned as a
// ManagerPlan for the user to review.
//
// File tools (read_file, list_files, search_files) are dispatched to the
// sandboxed worker via the LaunchHandle, same as the single-agent loop.

import type { SqliteDb } from '../db/client.js'
import type { PushEvents, LaunchHandle } from '../project/manager.js'
import type { ManagerPlan, PlannedTask, ToolName } from '@codekalakaars/vajra-protocol'
import type { ChatProvider, ChatMessage } from './providers/types.js'
import { getManagerToolSpecs, parseToolCall } from './tools.js'
import { formatSummaryIndexHierarchical, type SummaryEntry } from './summary.js'
import { projectContext } from './project-context.js'
import { compressMessages } from './context.js'
import { searchSummary, appendMessage, nextSeq } from './utils.js'
import { MAX_MANAGER_TOOL_CALLS, MAX_TASK_CONTEXT_SIZE, MAX_CONTEXT_LINES } from './constants.js'
import { componentLogger } from '../logger.js'

const log = componentLogger('manager')

const FREE_TOOLS = new Set(['search_files'])

function buildManagerConversationPrompt(
  projectDir: string,
  tree: string,
  summary: string,
  architecture?: string,
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
    '- instructions: EXACT step-by-step instructions (e.g. "Add try-catch around line 42 in src/api.ts")',
    '- readFile: Files the worker needs to read for context',
    '- writeFile: Files the worker will create or modify',
    '- deleteFile: Files to delete',
    '- createDir: Directories to create',
    '- validation: Commands to run after completion (must exit 0 on success)',
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
    '',
    ...(architecture ? ['Architecture:', architecture] : []),
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
): Promise<string> {
  // Combine all files that need to be read or written
  const allFiles = [...new Set([...readFile, ...writeFile])]

  // One round trip each, serially, meant the plan sat waiting on IPC for as
  // many hops as it had files.
  const reads = await Promise.all(
    allFiles.map(async (filePath) => {
      try {
        const result = await handle.callTool('read_file', { path: filePath })
        return { filePath, content: typeof result === 'string' ? result : JSON.stringify(result) }
      } catch {
        return null // File might not exist yet (for writeFile targets)
      }
    }),
  )

  const contextParts: string[] = []
  let currentSize = 0

  for (const read of reads) {
    if (!read) continue
    if (currentSize >= MAX_TASK_CONTEXT_SIZE) break

    const relevantLines = extractRelevantLines(read.content, instructions)
    if (relevantLines.length === 0) continue

    const snippet = `\n--- ${read.filePath} ---\n${relevantLines}\n--- end ${read.filePath} ---`
    contextParts.push(snippet)
    currentSize += snippet.length
  }

  return contextParts.join('\n')
}

/**
 * Extract relevant lines from a file based on instructions.
 * Looks for line numbers, function names, or class names mentioned in instructions.
 */
function extractRelevantLines(content: string, instructions: string[]): string {
  const lines = content.split('\n')
  const relevantLineNumbers = new Set<number>()

  // Extract line numbers from instructions (e.g., "line 42", "lines 10-20")
  for (const instruction of instructions) {
    // Match "line N" or "lines N-M"
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

    // Match function/class names from instructions
    const nameMatches = instruction.match(/\b(?:function|class|const|let|var|async)\s+(\w+)/g)
    if (nameMatches) {
      for (const match of nameMatches) {
        const name = match.replace(/\b(?:function|class|const|let|var|async)\s+/, '')
        // Find this name in the file
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(name)) {
            relevantLineNumbers.add(i)
            // Also add surrounding context (2 lines before/after)
            for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
              relevantLineNumbers.add(j)
            }
          }
        }
      }
    }
  }

  // If no specific lines found, return the head of the file as context
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

/**
 * Identify key files in the project for initial exploration.
 * Returns files that are likely entry points, configs, or architecture-defining.
 */
function identifyKeyFiles(summary: SummaryEntry[]): string[] {
  const keyFiles: string[] = []
  
  // Common entry points and config files
  const entryPatterns = [
    /package\.json$/,
    /tsconfig\.json$/,
    /src\/index\.(ts|js|tsx|jsx)$/,
    /src\/main\.(ts|js|tsx|jsx)$/,
    /src\/app\.(ts|js|tsx|jsx)$/,
    /src\/App\.(ts|js|tsx|jsx)$/,
    /src\/routes?\.(ts|js)$/,
    /src\/server\.(ts|js)$/,
    /src\/client\.(ts|js)$/,
    /README\.md$/,
    /.*config\.(ts|js|json)$/,
    /.*\.config\.(ts|js|json)$/,
  ]
  
  // Find files matching entry patterns
  for (const entry of summary) {
    for (const pattern of entryPatterns) {
      if (pattern.test(entry.path)) {
        keyFiles.push(entry.path)
        break
      }
    }
  }
  
  // Find files with high export counts (likely architecture-defining)
  const highExportFiles = summary
    .filter(e => e.exportCount >= 3)
    .sort((a, b) => b.exportCount - a.exportCount)
    .slice(0, 5)
    .map(e => e.path)
  
  keyFiles.push(...highExportFiles)
  
  // Find files with many imports (likely integration points)
  const highImportFiles = summary
    .filter(e => e.importCount >= 5)
    .sort((a, b) => b.importCount - a.importCount)
    .slice(0, 5)
    .map(e => e.path)
  
  keyFiles.push(...highImportFiles)
  
  // Deduplicate and return top files
  return [...new Set(keyFiles)].slice(0, 10)
}

/**
 * Analyze project architecture from key files.
 * Returns a summary of the project's structure and patterns.
 */
async function analyzeArchitecture(
  summary: SummaryEntry[],
  handle: LaunchHandle,
): Promise<string> {
  const keyFiles = identifyKeyFiles(summary).slice(0, 5)

  // Read them together: one round trip each, serially, was five round trips
  // of latency before the manager could say anything at all.
  const reads = await Promise.all(
    keyFiles.map(async (filePath) => {
      try {
        const result = await handle.callTool('read_file', { path: filePath })
        return { filePath, content: typeof result === 'string' ? result : JSON.stringify(result) }
      } catch {
        return null // Skip unreadable files
      }
    }),
  )

  const architectureParts: string[] = []
  for (const read of reads) {
    if (!read) continue

    const lines = read.content.split('\n')
    const imports = lines.filter(l => l.startsWith('import ')).slice(0, 5)
    const exports = lines.filter(l => l.startsWith('export ')).slice(0, 5)

    architectureParts.push(`--- ${read.filePath} ---`)
    if (imports.length > 0) architectureParts.push(`Imports: ${imports.join(', ')}`)
    if (exports.length > 0) architectureParts.push(`Exports: ${exports.join(', ')}`)
    architectureParts.push('')
  }

  return architectureParts.join('\n')
}

export function parseProposePlanArgs(raw: unknown): ManagerPlan {
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

  // Compute independent groups from dependency graph
  const independentGroups: string[][] = []
  const assigned = new Set<string>()
  for (const task of tasks) {
    if (assigned.has(task.id)) continue
    const group = [task.id]
    assigned.add(task.id)
    // Find tasks with no deps on unassigned tasks
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

  // Optimize task ordering for parallelism
  const optimizedTasks = optimizeTaskOrder(tasks, independentGroups)

  // Estimate task durations
  const tasksWithDuration = estimateTaskDurations(optimizedTasks)

  return {
    tasks: tasksWithDuration,
    independentGroups,
    estimatedWorkers: Math.max(1, ...independentGroups.map((g) => g.length)),
  }
}

/**
 * Estimate task duration based on complexity and file count.
 * Returns tasks with estimatedDuration added.
 */
function estimateTaskDurations(tasks: PlannedTask[]): PlannedTask[] {
  // Base duration in minutes by complexity
  const baseDuration: Record<string, number> = {
    low: 30,    // 30 minutes
    medium: 120, // 2 hours
    high: 240,   // 4 hours
  }

  return tasks.map(task => {
    const base = baseDuration[task.complexity ?? 'medium'] ?? 120
    
    // Adjust based on file count
    const fileCount = task.readFile.length + task.writeFile.length
    const fileMultiplier = Math.max(1, fileCount / 3) // 3 files = 1x, 6 files = 2x
    
    // Adjust based on validation count
    const validationMultiplier = Math.max(1, task.validation.length / 2) // 2 commands = 1x
    
    const estimatedDuration = Math.round(base * fileMultiplier * validationMultiplier)
    
    return {
      ...task,
      estimatedDuration,
    }
  })
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

export interface ManagerTurnInput {
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
}

export type ManagerTurnResult =
  | { type: 'response'; response: string }
  | { type: 'plan'; plan: ManagerPlan }

/**
 * Run one turn of the Manager's conversation.
 *
 * On the first call, builds the system prompt with project context.
 * Subsequent calls reuse the existing conversation history.
 *
 * Returns either a text response (Manager is still gathering context) or
 * a ManagerPlan (Manager called propose_plan).
 */
export async function managerConversationTurn(
  input: ManagerTurnInput,
): Promise<ManagerTurnResult> {
  const { projectId, projectDir, userMessage, model, apiKey, provider, events, db, handle, messages, summaryIndex } = input

  // First turn: build system prompt and project context
  if (messages.length === 0) {
    const context = await projectContext(projectDir)
    const tree = context.tree
    if (summaryIndex.length === 0) {
      summaryIndex.push(...context.summaryIndex)
    }

    // Auto-analyze architecture from key files
    events.push('projects.workerProgress', projectId, {
      projectId,
      agentId: 'manager',
      taskId: 'master',
      detail: 'Analyzing project architecture...',
    })
    const architecture = await analyzeArchitecture(summaryIndex, handle)

    const summaryText = formatSummaryIndexHierarchical(summaryIndex)
    messages.push({
      role: 'system',
      content: buildManagerConversationPrompt(projectDir, tree, summaryText, architecture),
    })
  }

  // Persist user message
  const userSeq = nextSeq(db, projectId)
  appendMessage(db, projectId, userSeq, 'user', userMessage)

  // Add user message to conversation
  messages.push({ role: 'user', content: userMessage })

  const providerType = provider.name === 'anthropic' ? 'anthropic' : 'openai'
  const toolSpecs = getManagerToolSpecs(providerType)
  let toolCallCount = 0

  // Tool-use loop (Manager may call read_file/list_files/search_files before proposing)
  while (toolCallCount < MAX_MANAGER_TOOL_CALLS) {
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
      const seq = nextSeq(db, projectId)
      appendMessage(db, projectId, seq, 'assistant', content)
      messages.push(result.message)
      return { type: 'response', response: content }
    }

    // Has tool calls — process them
    messages.push(result.message)

    for (const toolCall of result.message.toolCalls) {
      // Intercept propose_plan — never dispatch to worker
      if (toolCall.name === 'propose_plan') {
        let parsed: unknown
        try {
          parsed = JSON.parse(toolCall.arguments)
        } catch {
          // Bad JSON — tell the LLM and let it retry
          messages.push({
            role: 'tool',
            content: 'Error: propose_plan arguments were not valid JSON. Please try again.',
            toolCallId: toolCall.id,
          })
          continue
        }

        const plan = parseProposePlanArgs(parsed)

        // Inject relevant code context into task instructions
        events.push('projects.workerProgress', projectId, {
          projectId,
          agentId: 'manager',
          taskId: 'master',
          detail: 'Injecting code context into task instructions...',
        })

        await Promise.all(plan.tasks.map(async (task) => {
          const context = await readTaskContext(
            task.readFile,
            task.writeFile,
            task.instructions,
            handle,
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
        }))

        // Emit plan events
        events.push('projects.planStarted', projectId, { projectId })
        for (const t of plan.tasks) {
          events.push('projects.planTask', projectId, { projectId, task: t })
        }
        events.push('projects.planComplete', projectId, { projectId, plan })

        // Persist the plan as the final assistant message
        const planSeq = nextSeq(db, projectId)
        appendMessage(db, projectId, planSeq, 'assistant', JSON.stringify(plan))

        return { type: 'plan', plan }
      }

      // All other tools: dispatch to sandboxed worker
      const isFree = FREE_TOOLS.has(toolCall.name)
      if (!isFree) toolCallCount++
      // Over budget: answer the call with an error instead of breaking out of
      // the batch. Every tool call in the assistant message needs a result —
      // leaving one unanswered makes the next request invalid.
      const overBudget = !isFree && toolCallCount > MAX_MANAGER_TOOL_CALLS

      const parsed = parseToolCall(toolCall)
      let resultContent: string

      if (overBudget) {
        resultContent = `Error: tool call budget exhausted (${MAX_MANAGER_TOOL_CALLS}). Stop exploring and either ask the user a question or call propose_plan.`
      } else if (!parsed.ok) {
        resultContent = `Error: ${parsed.error}`
      } else if (parsed.call.tool === ('search_files' as ToolName)) {
        // Handle search_files in main process (in-memory index)
        const args = parsed.call.args as { query: string }
        resultContent = searchSummary(summaryIndex, args.query)
      } else {
        // Dispatch read_file / list_files to sandboxed worker
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
        toolCallId: toolCall.id,
      })
    }
  }

  // Exceeded tool budget — force a response
  const fallbackContent = 'I have enough context. Let me propose a plan.'
  messages.push({ role: 'assistant', content: fallbackContent })
  return { type: 'response', response: fallbackContent }
}
