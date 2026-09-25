import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FileLockManager,
  ChangeHistory,
  resolveConcurrencyConfig,
} from '@codekalakaars/vajra-sandbox'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import {
  developerConversationTurn,
  type LaunchHandle,
  type DeveloperTurnResult,
} from '../agent/developer.js'
import { AgentRegistry, type AgentState } from '../agent/registry.js'
import { TaskQueue, type TaskState } from '../agent/taskqueue.js'
import { streamChatCompletion, type ChatMessage } from '../agent/chat.js'
import { evaluateSkipIf } from '../tasks/skip.js'
import { computeTaskPermissions, normalizeProjectPath } from '../tasks/permissions.js'
import { executeTask } from '../tasks/execute.js'
import { needsServer } from '../tasks/server.js'
import { createToolHandle, tokenizeCommand, type ToolCache } from '../tools/handle.js'
import { finalReport } from '../tasks/report.js'
import { isSupportedModel } from '../env.js'
import { launchSandboxSession, type SandboxSession } from '../sandbox/launch.js'
import {
  SESSION_SCHEMA_VERSION,
  DIRECTORY_FILE_HASH,
  MISSING_FILE_HASH,
  UNREADABLE_FILE_HASH,
  appendMessage,
  inspectFile,
  loadMessages,
  loadSession,
  loadSummaryIndexCache,
  readGitState,
  repoFingerprint,
  saveSession,
  saveSummaryIndexCache,
  type PersistedTask,
  type SessionPhase,
  type SummaryIndexCacheEntry,
} from '../persist/index.js'
import { masterDecide, masterLoop, runRollbackCommands, MASTER_DECIDE_TOOL_SPECS } from '../agent/master.js'
import { blocksAutomaticResume, describeVerdict, planResume } from './resume.js'
import type { AgentEvent, SessionUI } from './ui.js'

const DEFAULT_MAX_RETRIES = 2
const MAX_CONVERSATION_TURNS = 20

/**
 * Bound on task concurrency (P2): `resolveConcurrencyConfig().maxConcurrentWorkers`
 * unless the `--concurrency` flag overrides it. Clamped to >= 1 so a zero or
 * negative flag can never freeze the scheduler.
 */
export function resolveMaxWorkers(override?: number): number {
  const configured = resolveConcurrencyConfig().maxConcurrentWorkers
  const candidate = override === undefined ? configured : override
  if (!Number.isFinite(candidate)) return configured
  return Math.max(1, Math.floor(candidate))
}

const COMMAND_RESOURCE_PATHS: Record<string, string> = {
  git: 'resource:git',
  npm: 'resource:node_modules',
  npx: 'resource:node_modules',
  pnpm: 'resource:node_modules',
  yarn: 'resource:node_modules',
  cargo: 'resource:cargo',
}

export function commandResourcePath(command: string, argv?: readonly string[]): string | null {
  let executable: string
  if (argv?.[0]) {
    executable = argv[0]
  } else {
    const tokenized = tokenizeCommand(command)
    if (!tokenized.ok) return null
    executable = tokenized.argv[0]
  }
  const name = (executable.split(/[\\/]/).pop() ?? '').toLowerCase()
  return COMMAND_RESOURCE_PATHS[name] ?? null
}

export function withCommandResourceLock(
  handle: LaunchHandle,
  locks: FileLockManager,
  owner: string,
): LaunchHandle {
  let nextLockId = 1
  return {
    callTool: async (tool, args) => {
      if (tool !== 'run_command' || (typeof args !== 'object' || args === null)) {
        return handle.callTool(tool, args)
      }
      const command = String((args as { command?: unknown }).command ?? '')
      const argv = Array.isArray((args as { argv?: unknown }).argv)
        ? (args as { argv: unknown[] }).argv.map(String)
        : undefined
      const path = commandResourcePath(command, argv)
      if (path === null) return handle.callTool(tool, args)

      const lockOwner = `${owner}:command-resource:${nextLockId++}`
      await locks.acquireOrWait([path], lockOwner, 'write')
      try {
        return await handle.callTool(tool, args)
      } finally {
        locks.releaseFiles([path], lockOwner)
      }
    },
  }
}

/**
 * §3: session startup spends real time building the summary index. An unchanged
 * repo should reuse the cached one — keyed on a cheap file-count + mtime
 * fingerprint, not on content, because hashing everything would cost as much
 * as building it.
 */
/** The Master tool loop parses model output; malformed JSON is not fatal. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function seedSummaryIndex(projectDir: string): SummaryIndexCacheEntry[] {
  try {
    const fingerprint = repoFingerprint(projectDir)
    const cached = loadSummaryIndexCache(projectDir, fingerprint)
    if (cached) return cached.entries
  } catch {
    // A broken cache is never fatal — the index is simply rebuilt below.
  }
  return []
}

export interface SessionOptions {
  task?: string
  apiKey?: string
  model: string
  projectDir: string
  autoConfirm?: boolean
  timeout?: number
  /** Explicit opt-in to run without OS sandbox enforcement. */
  allowUnenforced?: boolean
  /** Overrides `resolveConcurrencyConfig().maxConcurrentWorkers` (P2). */
  concurrency?: number
  /**
   * Resume a persisted session. The staleness gate runs first and can refuse:
   * `vajra resume` passes `force: true` only after the user has seen exactly
   * what changed.
   */
  resumeFrom?: string
  /** Skip the staleness gate. Only ever set from an explicit user decision. */
  force?: boolean
  /** Task ids the user explicitly accepted rolling back to their baselines. */
  rollbackTasks?: string[]
  /**
   * §4: let the Manager ask the model what to do about a failure. Off by
   * default — the mechanical decisions are the ones that must be predictable.
   */
  useMasterLlm?: boolean
  /** Host-owned abort (Ctrl-C / TUI interrupt). Aborting finishes the current step. */
  signal?: AbortSignal
  /**
   * Called with a teardown for the sandbox worker as soon as it exists
   * (and with null when the session ends without one) so a host can force
   * quit without orphaning the forked worker.
   */
  onSandboxClose?: (close: (() => void) | null) => void
}

export interface SessionResult {
  /** Process exit code: 0 clean/exit-command, report code after execution, 130 interrupted. */
  exitCode: number
  interrupted: boolean
  /** User typed exit/quit. */
  exited: boolean
}

export function isExitCommand(message: string): boolean {
  const lower = message.trim().toLowerCase()
  return lower === 'exit' || lower === 'quit' || lower === '/exit' || lower === '/quit'
}

/**
 * Interactive developer-agent session, frontend-agnostic. The host supplies a
 * SessionUI (readline for the CLI, Ink for the TUI) and an optional abort
 * signal; this function never touches process.stdin/stdout directly.
 */
export async function runSession(
  options: SessionOptions,
  ui: SessionUI,
): Promise<SessionResult> {
  if (!isSupportedModel(options.model)) {
    ui.error(
      `Unsupported model '${options.model}': only zen/* and go/* are supported`,
    )
    return { exitCode: 1, interrupted: false, exited: false }
  }
  if (!options.apiKey) {
    ui.error(
      `No API key provided for model '${options.model}'. Set OPENCODE_API_KEY or use --api-key`,
    )
    return { exitCode: 1, interrupted: false, exited: false }
  }
  // Narrowed here so nested closures (the per-task runner) see a definite string.
  const apiKey = options.apiKey

  const projectDir = resolve(options.projectDir)
  if (!existsSync(projectDir)) {
    ui.error(`Project directory does not exist: ${projectDir}`)
    return { exitCode: 1, interrupted: false, exited: false }
  }

  const toolCache: ToolCache = { read: new Map(), generation: 0 }
  const abortSignal = options.signal ?? new AbortController().signal
  const isInterrupted = () => abortSignal.aborted
  let exited = false

  // Declared early so a host force-quit can close the worker even before
  // launchSandboxSession resolves.
  let sandbox: SandboxSession | null = null
  options.onSandboxClose?.(null)
  const notifySandboxClose = () => options.onSandboxClose?.(() => sandbox?.close())

  ui.banner()

  // §3: a resume continues the *same* session, so the transcript, plan and
  // task states stay in one record instead of accumulating fragments.
  const sessionId = options.resumeFrom ?? randomUUID()
  const createdAt = Date.now()
  const registry = new AgentRegistry()
  const fileLocks = new FileLockManager()
  const commandResourceLocks = new FileLockManager()
  // D1: ChangeHistory always records against the resolved projectDir.
  const changeHistory = new ChangeHistory(projectDir)

  const masterAgent = registry.createAgent(sessionId, 'master', 'Orchestrate task execution')
  registry.updateStatus(masterAgent.id, 'running')

  ui.info(`Model: ${options.model}`)
  ui.info(`Timeout: ${options.timeout ?? 300}s per task`)

  // Q: fork a confined worker for tool execution. Parent never calls
  // applySandbox itself. Fail closed unless the user explicitly opted into
  // unenforced mode; only that explicit mode may fall back in-process.
  const allowUnenforced = options.allowUnenforced ?? false
  try {
    sandbox = await launchSandboxSession(projectDir, sessionId, {
      allowUnenforced,
      requireEnforced: !allowUnenforced,
    })
    notifySandboxClose()
    if (sandbox.report.enforced) {
      ui.info(`Sandbox: ${sandbox.report.mechanism}`)
    } else {
      ui.warning(
        `Sandbox not enforced (${sandbox.report.mechanism}) — tools run with app-level permissions only`,
      )
    }
    for (const w of sandbox.report.warnings) ui.warning(w)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!allowUnenforced) {
      ui.error(`Sandbox unavailable: ${message}`)
      ui.error('Re-run with --allow-unenforced to continue without OS sandbox enforcement.')
      sandbox?.close()
      return { exitCode: 1, interrupted: false, exited: false }
    }
    ui.warning(
      `Sandbox unavailable: ${message} — falling back to in-process tools (explicit --allow-unenforced)`,
    )
  }

  const finish = (exitCode: number): SessionResult => {
    registry.updateStatus(masterAgent.id, isInterrupted() ? 'failed' : 'done')
    sandbox?.close()
    let code = exitCode
    if (isInterrupted() && code === 0) code = 130
    if (isInterrupted()) {
      ui.warning('Session interrupted. Progress has been saved.')
    }
    return { exitCode: code, interrupted: isInterrupted(), exited }
  }

  const developerHandle: LaunchHandle = sandbox?.handle ?? createToolHandle(projectDir, { cache: toolCache })

  // The port requires onAgentEvent, but JavaScript test doubles and embedders
  // may not implement it. Observability must never be able to fail a run.
  const agentUi = ui as { onAgentEvent?: (event: AgentEvent) => void }
  const emitAgent = (event: AgentEvent): void => {
    try {
      agentUi.onAgentEvent?.(event)
    } catch {
      // a renderer that throws must not take the session down
    }
  }

  const messages: ChatMessage[] = []
  const summaryIndex: Array<{
    path: string
    symbols: string[]
    preview: string
    lineCount: number
    importCount: number
    exportCount: number
  }> = seedSummaryIndex(projectDir)

  /**
   * §3 resume. The gate runs before anything is replayed: a changed tree is
   * reported, never silently rolled back. `force` is the user's answer to
   * that report, not a default.
   */
  let resumedPhase: SessionPhase | null = null
  let resumedPlan: DeveloperPlan | null = null
  let resumedCompleted = new Set<string>()
  if (options.resumeFrom) {
    // The sandbox is already up by now, so every exit below has to tear it
    // down — otherwise the forked worker keeps the CLI alive.
    const bail = (message: string): SessionResult => {
      sandbox?.close()
      ui.error(message)
      return { exitCode: 1, interrupted: false, exited: false }
    }
    let stored: ReturnType<typeof loadSession> = null
    try {
      stored = loadSession(options.resumeFrom, projectDir)
    } catch (e) {
      // An unsafe id throws before we can report anything useful.
      return bail(e instanceof Error ? e.message : String(e))
    }
    if (!stored) {
      return bail(`No resumable session '${options.resumeFrom}' in ${projectDir}`)
    }
    const plan = planResume(stored, {
      projectDir,
      ...(options.force ? { assumeFresh: true } : {}),
      ...(options.rollbackTasks ? { rollbackTaskIds: options.rollbackTasks } : {}),
    })

    if (blocksAutomaticResume(plan.staleness.verdict)) {
      sandbox?.close()
      ui.error(describeVerdict(plan.staleness))
      for (const [path, how] of Object.entries(plan.staleness.changed)) {
        ui.warning(`  ${how === 'deleted' ? 'deleted' : 'modified'}: ${path}`)
      }
      ui.warning(
        'Re-run with --force to continue anyway, or re-plan the work from scratch.',
      )
      return { exitCode: 1, interrupted: false, exited: false }
    }

    const restored = loadMessages(stored.sessionId, projectDir)
    messages.push(...(restored as unknown as ChatMessage[]))
    resumedPhase = plan.phase
    resumedPlan = stored.plan
    resumedCompleted = new Set(plan.completed)
    ui.info(`Resumed session ${stored.sessionId} (${plan.completed.length} task(s) already done).`)
    if (plan.staleness.checked > 0) {
      ui.info(describeVerdict(plan.staleness))
    }
  }

  let recordedMessages = 0
  try {
    recordedMessages = options.resumeFrom ? loadMessages(options.resumeFrom, projectDir).length : 0
  } catch {
    // Reported properly by the resume block below.
  }

  /**
   * §3: record a proposed plan before anything runs, so "the plan is on screen
   * but not yet approved" is a resumable state rather than a lost one.
   */
  const recordProposedPlan = (plan: DeveloperPlan): void => {
    try {
      saveSession({
        version: SESSION_SCHEMA_VERSION,
        sessionId,
        projectDir,
        createdAt,
        updatedAt: Date.now(),
        config: {
          model: options.model,
          timeoutSeconds: options.timeout ?? 300,
          allowUnenforced,
        },
        phase: 'awaiting-approval',
        plan,
        evidence: null,
        tasks: Object.fromEntries(
          plan.tasks.map(t => [t.id, { status: 'pending' as const }]),
        ),
        fileHashes: {},
        summaryFingerprint: null,
      })
    } catch (e) {
      ui.warning(`Could not persist session state: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  let initialMessage = options.task
  let initialKind: 'first' | 'reentry' = 'first'

  /**
   * §3: append the messages that are not already on disk. The developer's
   * `messages` array is the live conversation, so only the tail is new.
   */
  const recordConversation = (): void => {
    try {
      for (let i = recordedMessages; i < messages.length; i++) {
        const m = messages[i]
        appendMessage(sessionId, projectDir, {
          role: m.role,
          content: m.content ?? null,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {}),
        })
      }
      recordedMessages = messages.length
    } catch (e) {
      ui.warning(`Could not record conversation: ${e instanceof Error ? e.message : String(e)}`)
    }
    flushIndexCache()
  }

  /** §3: publish the index so the next session on an unchanged repo skips it. */
  let indexCacheWritten = false
  const flushIndexCache = (): void => {
    if (indexCacheWritten || summaryIndex.length === 0) return
    try {
      saveSummaryIndexCache(projectDir, {
        version: 1,
        fingerprint: repoFingerprint(projectDir),
        createdAt: Date.now(),
        entries: summaryIndex,
      })
      indexCacheWritten = true
    } catch {
      // Caching is an optimisation; a failure must not affect the session.
    }
  }
  const resuming = Boolean(options.resumeFrom)
  if (!initialMessage && !resuming) {
    initialMessage = await ui.askInitialTask(initialKind)
  }

  // D7: honour exit/quit at the first prompt, not only on later turns.
  while (!resuming && (!initialMessage || isExitCommand(initialMessage))) {
    if (initialMessage && isExitCommand(initialMessage)) {
      ui.info('Goodbye!')
      exited = true
      return finish(0)
    }
    initialKind = 'reentry'
    initialMessage = await ui.askInitialTask(initialKind)
  }

  if (!resuming) {
    emitAgent({ type: 'phase', agent: { role: 'developer' }, phase: 'scanning' })
    ui.info(`\n🔍 Scanning project in ${projectDir}...`)
    ui.info(`💬 Starting conversation with developer...\n`)
  }

  let result: DeveloperTurnResult | undefined
  let userMessage = initialMessage ?? ''

  // §3: a session that stopped short of running anything re-presents its plan
  // instead of asking the Developer to plan all over again.
  let preselected: DeveloperTurnResult | null =
    resumedPhase === 'awaiting-approval' && resumedPlan ? { type: 'plan', plan: resumedPlan } : null
  // Mid-execution: go straight back to the work that did not finish.
  if (resumedPhase === 'executing' && resumedPlan) {
    preselected = { type: 'plan', plan: resumedPlan }
    options.autoConfirm = true
  }

  let turn = 0
  for (turn = 0; turn < MAX_CONVERSATION_TURNS; turn++) {
    if (isInterrupted()) break

    if (preselected) {
      result = preselected
      preselected = null
    } else {
      try {
        result = await developerConversationTurn({
          sessionId,
          projectDir,
          userMessage,
          model: options.model,
          apiKey: options.apiKey,
          handle: developerHandle,
          messages,
          summaryIndex,
          onTextDelta: text => ui.onTextDelta(text),
          onThinkingDelta: text => ui.onThinkingDelta(text),
          isInterrupted,
          signal: abortSignal,
          onAgentEvent: emitAgent,
        })
      } catch (e) {
        if (isInterrupted()) break
        ui.error(`API error: ${e instanceof Error ? e.message : String(e)}`)
        ui.warning('Check your API key and network connection.')
        break
      }

      ui.finishLine()
    }

    recordConversation()

    if (result.type === 'plan') {
      ui.showPlan(result.plan)

      let confirmed = false
      if (options.autoConfirm) {
        ui.info('Auto-confirming plan (--yes flag)\n')
        confirmed = true
      } else {
        // §3: record the phase *before* asking, so a crash or a Ctrl-C at the
        // prompt is still a resumable session rather than a lost plan.
        recordProposedPlan(result.plan)
        // D8: confirmation is [y/N] — anything other than yes rejects.
        confirmed = (await ui.askConfirmPlan()) === 'y'
      }

      if (!confirmed) {
        ui.warning('Plan rejected. What would you like to change?')
        userMessage = await ui.askRejectFeedback()
        if (userMessage && isExitCommand(userMessage)) {
          ui.info('Goodbye!')
          exited = true
          return finish(0)
        }
        continue
      }

      ui.info('\n🚀 Executing tasks...\n')

      // D3: queue default timeout comes from the CLI -t flag (seconds).
      const queue = new TaskQueue(sessionId, options.timeout ?? 300)
      const plan: DeveloperPlan = result.plan
      for (const task of plan.tasks) {
        queue.addTask(task)
      }

      // §3: a mid-execution resume re-runs only what did not complete. The
      // completed tasks stay recorded as done so the final report is honest
      // about what this session actually did.
      if (resumedCompleted.size > 0) {
        for (const taskId of resumedCompleted) {
          if (!queue.getTask(taskId)) continue
          queue.markAlreadyDone(taskId)
        }
        ui.info(
          `Skipping ${resumedCompleted.size} task(s) that already completed in a previous run.`,
        )
      }

      // P2: bounded by resolveConcurrencyConfig().maxConcurrentWorkers,
      // overridable per run via SessionOptions.concurrency (--concurrency).
      const maxWorkers = resolveMaxWorkers(options.concurrency)
      // Computed once: the staleness gate and the index cache need these, and
      // a repo walk or a git call on every task transition would be absurd.
      const summaryFingerprint = repoFingerprint(projectDir)
      const gitState = readGitState(projectDir)

      const allTaskFilePaths = (): string[] => {
        const paths = new Set<string>()
        for (const t of queue.getAllTasks()) {
          for (const p of [...t.readFile, ...t.writeFile, ...t.deleteFile, ...t.createDir]) {
            paths.add(normalizeProjectPath(projectDir, p))
          }
        }
        return [...paths]
      }
      const taskFilePaths = (task: TaskState): string[] => [
        ...task.readFile,
        ...task.writeFile,
        ...task.deleteFile,
        ...task.createDir,
      ].map(path => normalizeProjectPath(projectDir, path))
      const fileHashes: Record<string, string> = {}
      let fileHashesInitialized = false
      const updateFileHashes = (paths: readonly string[]): void => {
        for (const path of new Set(paths)) {
          const state = inspectFile(resolve(projectDir, path))
          if (state.kind === 'file') fileHashes[path] = state.hash
          else if (state.kind === 'directory') fileHashes[path] = DIRECTORY_FILE_HASH
          else if (state.kind === 'missing') fileHashes[path] = MISSING_FILE_HASH
          else fileHashes[path] = UNREADABLE_FILE_HASH
        }
      }
      ui.info(`Concurrency: ${maxWorkers} task${maxWorkers === 1 ? '' : 's'} at a time`)

      const taskErrors = new Map<string, string>()
      /** Tasks whose last attempt changed nothing — a retry cannot help. */
      const noOpTasks = new Set<string>()
      /** The worker agent each task is running under, for terminal transitions. */
      const taskAgents = new Map<string, string>()

      const persist = (task?: TaskState): void => {
        try {
          if (!fileHashesInitialized) {
            updateFileHashes(allTaskFilePaths())
            fileHashesInitialized = true
          } else if (task) {
            updateFileHashes(taskFilePaths(task))
          }

          const tasks: Record<string, PersistedTask> = {}
          for (const t of queue.getAllTasks()) {
            const entry: PersistedTask = { status: t.status }
            if (t.startedAt !== null) entry.startedAt = t.startedAt
            if (t.completedAt !== null) entry.completedAt = t.completedAt
            const err = taskErrors.get(t.id)
            if (err !== undefined) entry.error = err
            // Baselines make an interrupted task recoverable: a resume can
            // offer a rollback from the exact content this task started on.
            const baselines: Record<string, string | null> = {}
            for (const filePath of changeHistory.getTaskFiles(t.id)) {
              const original = changeHistory.getOriginalContent(t.id, filePath)
              if (original !== undefined) baselines[filePath] = original
            }
            if (Object.keys(baselines).length > 0) entry.baselines = baselines
            tasks[t.id] = entry
          }

          saveSession({
            version: SESSION_SCHEMA_VERSION,
            sessionId,
            projectDir,
            createdAt,
            updatedAt: Date.now(),
            config: {
              model: options.model,
              timeoutSeconds: options.timeout ?? 300,
              ...(maxWorkers === undefined ? {} : { concurrency: maxWorkers }),
              allowUnenforced,
            },
            phase: isInterrupted() ? 'finished' : 'executing',
            plan,
            evidence: null,
            tasks,
            fileHashes: { ...fileHashes },
            summaryFingerprint,
            ...(gitState ? { git: gitState } : {}),
          })
        } catch (e) {
          ui.warning(
            `Could not persist session state: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      // Plan accepted — record every task as pending before anything runs.
      persist()

      /**
       * One attempt of one task, end to end. Everything it owns (dirty flag,
       * permissions, handle scope, locks) is torn down on every exit path, and
       * a throw fails *this* task only — peers keep their changes.
       *
       * The retry policy is no longer here: the Manager decides whether this
       * gets another attempt. This returns whether the attempt succeeded.
       */
      const runTaskOnce = async (task: TaskState): Promise<boolean> => {
        let agent: AgentState | null = null
        let dirty = false
        try {
          const allTaskFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
          const allTaskPaths = [
            ...allTaskFiles,
            ...task.createDir,
          ].map(path => normalizeProjectPath(projectDir, path))
          // D4: wait for locks instead of permanently skipping on conflict.
          await fileLocks.acquireOrWait(allTaskPaths, task.id, 'write')

          // D2: track dirty-set via onMutate rather than changeHistory.hasChanges
          // alone (baseline records can make hasChanges unreliable across rollbacks).
          const permissions = computeTaskPermissions(task, projectDir)
          const permissionLookup = (path: string) =>
            permissions[normalizeProjectPath(projectDir, path)] ?? null

          let taskHandle: LaunchHandle
          if (sandbox) {
            taskHandle = sandbox.handleForTask(task.id, permissionLookup, () => {
              dirty = true
            })
          } else {
            taskHandle = createToolHandle(projectDir, {
              cache: toolCache,
              permissions: path => {
                const key = normalizeProjectPath(projectDir, path)
                return permissions[key] ?? { read: false, write: false, edit: false, delete: false }
              },
              onMutate: () => {
                dirty = true
              },
            })
          }
          taskHandle = withCommandResourceLock(taskHandle, commandResourceLocks, task.id)

          if (task.skipIf && task.skipIf.length > 0) {
            const shouldSkip = await evaluateSkipIf(
              task.skipIf,
              projectDir,
              async (command, args) => {
                const output = await taskHandle.callTool('run_command', {
                  command: [command, ...args].join(' '),
                  argv: [command, ...args],
                  timeoutMs: 30_000,
                })
                try {
                  const parsed = JSON.parse(String(output)) as { exitCode?: unknown }
                  return { code: typeof parsed.exitCode === 'number' ? parsed.exitCode : -1 }
                } catch {
                  return { code: -1 }
                }
              },
            )
            if (shouldSkip) {
              queue.skipTask(task.id)
              persist(task)
              ui.onTaskEvent({ type: 'skipped', title: task.title })
              return true
            }
          }

          agent = registry.createAgent(sessionId, 'worker', task.title, masterAgent.id)
          taskAgents.set(task.id, agent.id)
          queue.assignTask(task.id, agent.id)
          registry.updateStatus(agent.id, 'running')
          queue.startTask(task.id)

          // Progress label derived from the queue: terminal + in-flight counts
          // are still meaningful when tasks start and finish interleaved.
          const progress = queue.getStatus()
          ui.onTaskEvent({
            type: 'start',
            index:
              progress.done +
              progress.failed +
              progress.skipped +
              progress.assigned +
              progress.running,
            total: progress.total,
            title: task.title,
          })

          for (const filePath of allTaskFiles) {
            await changeHistory.recordBefore(task.id, filePath)
          }

          // Interrupted during setup: nothing has been written yet, so hand
          // the task back instead of reporting a run that never happened.
          if (isInterrupted()) {
            queue.returnToPending(task.id)
            if (agent) registry.updateStatus(agent.id, 'pending')
            persist(task)
            return true
          }

          dirty = false
          const success = await executeTask(
            agent.id,
            task,
            taskHandle,
            apiKey,
            options.model,
            ui,
            changeHistory,
            queue,
            registry,
            sessionId,
            fileLocks,
            projectDir,
            abortSignal,
            emitAgent,
          )

          const noChanges = !dirty && !changeHistory.hasChanges(task.id)
          if (noChanges && !success) {
            ui.onTaskEvent({ type: 'no-changes', title: task.title })
          }

          if (success) {
            queue.completeTask(task.id, true)
            registry.updateStatus(agent.id, 'done')
            persist(task)
            ui.onTaskEvent({ type: 'done', title: task.title })
            return true
          } else {
            if (dirty || changeHistory.hasChanges(task.id)) {
              await changeHistory.rollback(task.id)
            }
            // The Manager still owns the terminal state: it may roll back and
            // try again. Hand the failure back rather than failing here.
            noOpTasks.add(task.id)
            return false
          }
        } catch (e) {
          // A throw used to end the whole run and leak this task's locks.
          // Fail only this task, roll back only its own changes, persist.
          const message = e instanceof Error ? e.message : String(e)
          taskErrors.set(task.id, message)
          try {
            if (changeHistory.hasChanges(task.id)) {
              await changeHistory.rollback(task.id)
            }
          } catch {
            // Rollback is best effort — never let it mask the original error.
          }
          const state = queue.getTask(task.id)
          if (
            state &&
            state.status !== 'done' &&
            state.status !== 'failed' &&
            state.status !== 'skipped'
          ) {
            queue.failTask(task.id)
            ui.onTaskEvent({ type: 'failed', title: task.title })
          }
          if (agent) registry.updateStatus(agent.id, 'failed')
          persist(task)
          ui.error(`Task failed: ${task.title} — ${message}`)
          return false
        } finally {
          // Load-bearing under concurrency: a lock leaked here deadlocks every
          // peer waiting on those paths until the process is killed.
          fileLocks.release(task.id)
          sandbox?.releaseTask(task.id)
        }
      }

      /**
       * §4: the Manager owns the scheduler and the failure policy; this
       * callback just says how a single attempt is run.
       */
      const masterResult = await masterLoop({
        queue,
        maxWorkers,
        isInterrupted,
        defaultMaxRetries: DEFAULT_MAX_RETRIES,
        runTask: runTaskOnce,
        taskWasNoOp: id => noOpTasks.has(id),
        rollbackTask: async task => {
          // Honour the plan's own rollback commands first — without this the
          // `rollback` field is decorative.
          if (task.rollback && task.rollback.length > 0) {
            const handle = withCommandResourceLock(
              sandbox?.handle ?? createToolHandle(projectDir, { cache: toolCache }),
              commandResourceLocks,
              task.id,
            )
            const result = await runRollbackCommands(task.rollback, handle)
            if (result.failed.length > 0) {
              ui.warning(
                `Rollback command failed for ${task.title}: ${result.failed[0]}`,
              )
            }
          }
          if (changeHistory.hasChanges(task.id)) {
            await changeHistory.rollback(task.id)
          }
        },
        failTask: async (task, reason) => {
          if (changeHistory.hasChanges(task.id)) {
            await changeHistory.rollback(task.id)
          }
          const state = queue.getTask(task.id)
          if (state && state.status !== 'done' && state.status !== 'skipped') {
            queue.failTask(task.id)
            ui.onTaskEvent({ type: 'failed', title: task.title })
          }
          const agentId = taskAgents.get(task.id)
          if (agentId) registry.updateStatus(agentId, 'failed')
          // The Manager's reason is a fallback: a real error from the attempt
          // is more useful to whoever reads the record.
          if (!taskErrors.has(task.id)) taskErrors.set(task.id, reason)
          persist(task)
        },
        parkTask: async task => {
          queue.returnToPending(task.id)
          const agentId = taskAgents.get(task.id)
          if (agentId) registry.updateStatus(agentId, 'pending')
          persist(task)
        },
        rebaselineTask: async task => {
          // Re-baseline so the next attempt starts from the restored files.
          for (const filePath of [...task.readFile, ...task.writeFile, ...task.deleteFile]) {
            await changeHistory.recordBefore(task.id, filePath)
          }
        },
        onTaskEvent: event => ui.onTaskEvent(event),
        canAdmitTask: task => {
          const filePaths = [...task.readFile, ...task.writeFile, ...task.deleteFile, ...task.createDir]
            .map(path => normalizeProjectPath(projectDir, path))
          const resourcePaths = [
            ...task.rollback,
            ...task.validation,
            ...task.skipIf
              .filter(condition => /^command passes:/i.test(condition.trim()))
              .map(condition => condition.trim().replace(/^command passes:/i, '').trim()),
          ]
            .map(command => commandResourcePath(command))
            .filter((path): path is string => path !== null)
          const serverPath = needsServer(task.validation) ? '<resource:validation-server>' : null
          return fileLocks.canAcquire(filePaths, 'write', task.id) &&
            commandResourceLocks.canAcquire(resourcePaths, 'write', task.id) &&
            (serverPath === null || fileLocks.canAcquire([serverPath], 'write', task.id))
        },
        ...(options.useMasterLlm
          ? {
              decide: (task, context) =>
                masterDecide(
                  {
                    queue,
                    ask: async (systemPrompt, userMessage) => {
                      const messages: ChatMessage[] = [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage },
                      ]
                      const decided = await streamChatCompletion(
                        {
                          apiKey,
                          model: options.model,
                          messages,
                          tools: MASTER_DECIDE_TOOL_SPECS,
                          ...(abortSignal ? { signal: abortSignal } : {}),
                        },
                        () => {},
                      )
                      return (decided.message.tool_calls ?? []).map(call => ({
                        name: call.function.name,
                        args: safeJson(call.function.arguments),
                      }))
                    },
                  },
                  task,
                  context,
                  abortSignal,
                ),
            }
          : {}),
      })

      if (masterResult.aborted) {
        ui.warning(`Manager stopped the plan: ${masterResult.abortedReason ?? 'aborted'}`)
      }

      // Final flush so the record reflects exactly what is on disk now.
      persist()

      const finalStatus = queue.getStatus()
      ui.newline()
      ui.info('📊 Results:')
      const report = finalReport(finalStatus)
      for (const line of report.lines) {
        if (report.exitCode === 0) ui.success(line)
        else ui.warning(line)
      }
      ui.newline()
      if (report.exitCode === 0) {
        ui.success('✅ Done!')
      } else {
        ui.error('Completed with failures or pending tasks.')
      }
      return finish(report.exitCode)
    }

    userMessage = await ui.askUserMessage()

    if (!userMessage) {
      ui.warning('Empty message. Type "exit" to quit.')
      userMessage = 'exit'
    }

    if (isExitCommand(userMessage)) {
      ui.info('Goodbye!')
      exited = true
      return finish(0)
    }
  }

  if (turn >= MAX_CONVERSATION_TURNS && !isInterrupted() && result?.type !== 'plan') {
    // D9: we did not start execution after the turn cap — don't claim we did.
    ui.warning('Reached the 20-turn conversation limit. Continuing may be limited.')
  }

  return finish(0)
}
