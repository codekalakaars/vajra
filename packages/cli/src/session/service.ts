import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FileLockManager,
  ChangeHistory,
} from '@codekalakaars/vajra-sandbox'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import { SILENT_EXIT } from './ui.js'
import {
  createEvidenceLedger,
  developerConversationTurn,
  resetEvidenceLedger,
  type DeveloperTurnResult,
} from '../agent/developer.js'
import { AgentRegistry, type AgentState } from '../agent/registry.js'
import { TaskQueue, type TaskState, type TaskStatus } from '../agent/taskqueue.js'
import { streamChatCompletion, type ChatMessage, type ReasoningEffort } from '../agent/chat.js'
import { evaluateSkipIfDetailed } from '../tasks/skip.js'
import { taskLeases } from '../agent/leases.js'
import {
  createToolHandle,
  tokenizeCommand,
  computeTaskPermissions,
  normalizeProjectPath,
  spawnAgentPool,
  type Agent,
  type LaunchHandle,
  type ToolCache,
} from '@codekalakaars/vajra-agent-process'
import { executeTask } from '../tasks/execute.js'
import { buildProjectCard } from '../agent/project-card.js'
import { buildHandoff } from '../tasks/handoff.js'
import { diffsWithin, type DiffFile } from '../tasks/diff.js'
import type { AttemptRecord, Handoff, WorkerContext } from '../tasks/context-types.js'
import { needsServer } from '../tasks/server.js'
import { isSupportedModel } from '../env.js'
import { planRoleModels, roleReasoningEffort } from '../roles.js'
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
  type PersistedSession,
  type SessionPhase,
  type SummaryIndexCacheEntry,
} from '../persist/index.js'
import { masterDecide, masterLoop, runRollbackCommands, MASTER_DECIDE_TOOL_SPECS } from '../agent/master.js'
import { blocksAutomaticResume, describeVerdict, planResume } from './resume.js'
import { finalReport, type FinalReport } from '../tasks/report.js'
import type { AgentEvent, AgentPhase, SessionUI } from './ui.js'
import { TODAYS_PARAMS, type WorkerParams } from '../bench/params.js'
import { Governor, type Sampler } from '../agent/governor.js'
import { PauseGate } from '../agent/pause.js'

const MAX_CONVERSATION_TURNS = 20

/**
 * The cap on Workers running at once: none, unless `--concurrency` asks for one.
 *
 * Without a cap the machine decides — a task starts while CPU and RAM have room
 * for it, and the lowest-priority Worker is paused while the CPU is saturated
 * (`agent/governor.ts`). The flag stays as an explicit ceiling for a user who
 * wants one, clamped to >= 1 so a zero or negative value cannot freeze the
 * scheduler.
 */
export function resolveMaxWorkers(override?: number): number {
  if (override === undefined || !Number.isFinite(override)) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.floor(override))
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
  /** Omitted from the wire when 'off'. Set by the TUI's ctrl-r. */
  /** A level from the catalog for this model; chat.ts maps it to the wire. */
  reasoningEffort?: ReasoningEffort
  projectDir: string
  autoConfirm?: boolean
  timeout?: number
  /**
   * Hand the execution outcome back to the developer and keep the
   * conversation going, instead of ending the run when the queue drains.
   *
   * A task that failed on a bad anchor or a wrong split is planning input, not
   * a dead end: without this the developer never learns what its plan actually
   * did and the user cannot redirect. Interactive front-ends opt in; a
   * non-interactive run leaves it unset so its exit code is still exactly the
   * report's.
   */
  continueAfterExecution?: boolean
  /** Explicit opt-in to run without OS sandbox enforcement. */
  allowUnenforced?: boolean
  /** An optional cap on Workers at once. Absent: no cap; CPU and RAM decide. */
  concurrency?: number
  /**
   * Reads CPU and RAM for the scheduler. Injected by tests that measure the
   * scheduler rather than the machine running them; the machine's own by default.
   */
  sampler?: Sampler
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
   * ADR-0010: each role's model, configured independently. A role with no
   * override runs on `model`, which is what every role did before this existed.
   */
  developerModel?: string
  managerModel?: string
  workerModel?: string
  /**
   * §4: let the Manager ask the model what to do about a failure. Off by
   * default — the mechanical decisions are the ones that must be predictable.
   *
   * Naming a model for the Manager is the same decision, made in config
   * instead of on a flag, so it turns this on by itself: the Manager is an
   * agent (ADR-0010), and a model configured for it is a model being asked.
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

/**
 * `ui.onAgentEvent`, wrapped so a renderer cannot fail a run.
 *
 * The port requires `onAgentEvent`, but JavaScript test doubles and embedders may
 * not implement it. Observability must never be able to fail a run.
 */
export function safeAgentEmitter(ui: SessionUI): (event: AgentEvent) => void {
  const agentUi = ui as { onAgentEvent?: (event: AgentEvent) => void }
  return (event: AgentEvent): void => {
    try {
      agentUi.onAgentEvent?.(event)
    } catch {
      // a renderer that throws must not take the session down
    }
  }
}

/**
 * What a plan execution borrows from the session that proposed it.
 *
 * `runSession` supplies all of it. A bench run supplies almost none — no
 * Developer, no prompts, no persisted conversation — and that is the point: a
 * predefined plan reaches the scheduler through the same code path a session
 * uses, rather than a second implementation of it.
 */
export interface ExecutePlanDeps {
  /**
   * The Worker pool. Absent or `null` runs tools in-process: no OS sandbox and
   * no forked workers, which is what a bench run wants — the arrangement being
   * measured is the scheduler's, not the host's.
   */
  sandbox?: Agent | null
  /** The session this run belongs to; a fresh id when absent. */
  sessionId?: string
  /** Agents the session already created, so the record is one timeline. */
  registry?: AgentRegistry
  masterAgentId?: string
  toolCache?: ToolCache
  changeHistory?: ChangeHistory
  fileLocks?: FileLockManager
  commandResourceLocks?: FileLockManager
  /**
   * Tasks an earlier run completed. They are reported done without being run
   * again, so a resumed session is honest about what it inherited.
   */
  alreadyCompleted?: ReadonlySet<string>
  /**
   * Write the run's state out as it changes. Absent in bench: a tuning run must
   * not leave ten session records per suite in the user's store.
   */
  persistSession?: (
    phase: SessionPhase,
    plan: DeveloperPlan | null,
    tasks: Record<string, PersistedTask>,
    extra?: Partial<PersistedSession>,
    concurrency?: number,
  ) => void
  /** Reads CPU and RAM for the governor. Injected by the tests; the machine's own by default. */
  sampler?: Sampler
  /** The Manager asking the model what to do about a failure (ADR-0010). */
  managerDecision?: {
    model: string
    asks: boolean
    reasoningEffort: ReasoningEffort
  }
}

/** What one plan execution left behind. */
export interface ExecutePlanResult {
  /** The report's code: 0 when every task completed. */
  exitCode: number
  report: FinalReport
  /** The Manager stopped the plan rather than letting it drain. */
  aborted: boolean
  abortedReason?: string
  /** Workers the run was allowed at once, as params resolved it. */
  maxWorkers: number
  /** One row per task: how it ended, and why if it did not. */
  tasks: Array<{ id: string; title: string; status: TaskStatus; error?: string }>
  /** First Worker spawned to last task completed; 0 when none ever started. */
  wallMs: number
}

export function isExitCommand(message: string): boolean {
  if (message === SILENT_EXIT) return true
  const lower = message.trim().toLowerCase()
  return lower === 'exit' || lower === 'quit' || lower === '/exit' || lower === '/quit'
}

/**
 * A backstop on how much of a resumed conversation is put back on screen.
 *
 * Not a display budget. The transcript scrolls and a session's history is
 * whatever it is, so the conversation a user chose to resume is the conversation
 * they get to read — all of it, even when that is a hundred turns. This number
 * exists for a record that is not a conversation (a loop that appended thousands
 * of turns), where laying the whole thing out would stall the screen rather than
 * show it.
 */
const RESTORED_TURNS_LIMIT = 200

/**
 * Put a resumed conversation back in the transcript.
 *
 * A resume that starts on an empty screen is a resume that looks broken: the
 * model has the history, the user cannot see any of it, and the first thing
 * they are asked is what to do next. So the conversation is replayed as turns —
 * the same user blocks and markdown answers as a live session renders.
 *
 * Tool calls and tool results are not replayed: they are the agent's own
 * bookkeeping, they are long, and a session is resumed to continue the
 * *conversation*, not to re-read a transcript of every file the agent opened.
 * `system` turns are not replayed either — the prompt would be re-shown on
 * every resume, and it is not something a user said.
 */
function replayHistory(ui: SessionUI, messages: ChatMessage[]): void {
  const turns = messages
    .map(message => {
      const role = message.role
      const text = typeof message.content === 'string' ? message.content : ''
      if (text.trim() === '') return null
      if (role === 'user') return { role: 'user' as const, text }
      if (role === 'assistant') return { role: 'assistant' as const, text }
      return null
    })
    .filter((turn): turn is { role: 'user' | 'assistant'; text: string } => turn !== null)
  if (turns.length === 0) return

  // The port requires `restoredTurn`, but test doubles and embedders are
  // JavaScript and may not implement it — the same concession the port makes
  // for `onAgentEvent`. A renderer that throws on one turn must not cost the
  // user the rest of the history either.
  const replay = ui as { restoredTurn?: SessionUI['restoredTurn'] }
  const emit = (turn: { role: 'user' | 'assistant'; text: string }): void => {
    try {
      replay.restoredTurn?.(turn)
    } catch {
      /* a renderer that throws must not take the session down */
    }
  }

  const shown = turns.slice(-RESTORED_TURNS_LIMIT)
  const hidden = turns.length - shown.length
  if (hidden > 0) {
    ui.info(`… this session has ${turns.length} turns; the first ${hidden} are not shown`)
  }
  for (const turn of shown) emit(turn)
}

/**
 * The user said it, rather than the shell ending the turn on its own.
 *
 * `SILENT_EXIT` ends a run exactly as `exit` does — the loop unwinds and the
 * next run starts — but it is not something anyone typed, so it must not print
 * "Goodbye!" or land in the transcript as a user message. `isExitCommand` says
 * both are exits; this says which one to announce.
 */
function isUserExit(message: string): boolean {
  return message !== SILENT_EXIT && isExitCommand(message)
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
  /**
   * What each role runs on, resolved once — see roles.ts for why it is a
   * function and not three lines here.
   */
  const plan = planRoleModels({
    defaultModel: options.model,
    ...(options.developerModel !== undefined ? { developerModel: options.developerModel } : {}),
    ...(options.managerModel !== undefined ? { managerModel: options.managerModel } : {}),
    ...(options.workerModel !== undefined ? { workerModel: options.workerModel } : {}),
    ...(options.useMasterLlm !== undefined ? { useMasterLlm: options.useMasterLlm } : {}),
  })
  for (const bad of plan.invalid) {
    ui.error(
      `Unsupported ${bad.role} model '${bad.model}': only zen/* and go/* are supported`,
    )
  }
  if (plan.invalid.length > 0) return { exitCode: 1, interrupted: false, exited: false }
  const { developer: developerModel, manager: managerModel, worker: workerModel } = plan
  const managerAsks = plan.managerAsks
  const roleReasoning = (roleModel: string): ReasoningEffort =>
    roleReasoningEffort(roleModel, options.reasoningEffort)
  if (!options.apiKey) {
    ui.error(
      `No API key provided for model '${options.model}'. Run 'vajra auth login <key>', set OPENCODE_API_KEY, or use --api-key`,
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

  /**
   * Today's arrangement, with this session's own answers folded in.
   *
   * `executePlan` reads its arrangement from `params` and from nowhere else, so
   * a session resolves the two things a user can change on the command line —
   * how many Workers, and which model they run on — and hands them over here. A
   * bench run hands over the loaded `bench/config.json` instead. Same code, one
   * source of values.
   */
  const sessionParams: WorkerParams = {
    ...TODAYS_PARAMS,
    workerModel,
  }

  // Declared early so a host force-quit can close the worker even before
  // spawnAgentPool resolves.
  let sandbox: Agent | null = null
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

  /**
   * The last payload written, so the session can be marked finished without
   * rebuilding it — and so a conversation that never reaches a plan is still a
   * record rather than an orphan message log.
   */
  let lastPersisted: PersistedSession | null = null

  const persistSession = (
    phase: SessionPhase,
    plan: DeveloperPlan | null,
    tasks: Record<string, PersistedTask>,
    extra: Partial<PersistedSession> = {},
    /** The resolved worker count, which can differ from the requested flag. */
    concurrency?: number,
  ): void => {
    const payload: PersistedSession = {
      version: SESSION_SCHEMA_VERSION,
      sessionId,
      projectDir,
      createdAt,
      updatedAt: Date.now(),
      config: {
        model: options.model,
        ...(developerModel !== options.model ? { developerModel } : {}),
        ...(managerModel !== options.model ? { managerModel } : {}),
        ...(workerModel !== options.model ? { workerModel } : {}),
        timeoutSeconds: options.timeout ?? 300,
        ...((concurrency ?? options.concurrency) === undefined
          ? {}
          : { concurrency: concurrency ?? options.concurrency }),
        // Read from options, not the later `allowUnenforced` const: this runs
        // before the sandbox launch block declares it.
        allowUnenforced: options.allowUnenforced ?? false,
      },
      phase,
      plan,
      evidence: null,
      tasks,
      fileHashes: {},
      summaryFingerprint: null,
      ...extra,
    }
    try {
      saveSession(payload)
      lastPersisted = payload
    } catch (e) {
      ui.warning(
        `Could not persist session state: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  // Record a *new* session before the first prompt. The conversation log was
  // always written from turn one, but the session itself only appeared once a
  // plan was proposed — so a long conversation left a messages file that `vajra
  // sessions` could not list and `vajra resume` could not find.
  //
  // Never on a resume: the record being resumed is the record this run must not
  // touch, and writing an empty 'conversing' one here would erase the plan and
  // task states before the resume block below reads them back.
  if (!options.resumeFrom) {
    persistSession('conversing', null, {})
  }

  // Q: fork a confined worker for tool execution. Parent never calls
  // applySandbox itself. Fail closed unless the user explicitly opted into
  // unenforced mode; only that explicit mode may fall back in-process.
  const allowUnenforced = options.allowUnenforced ?? false
  try {
    // Pool-backed: one worker per in-flight task, so a crash costs one task
    // rather than every task. Same Agent surface, so nothing below
    // this line changes.
    sandbox = await spawnAgentPool(projectDir, sessionId, {
      allowUnenforced,
      requireEnforced: !allowUnenforced,
      // A worker that writes to its own stdout or stderr gets it said in the
      // transcript. It used to get it written straight to the terminal, which in
      // a TUI lands in the middle of the frame — and a resumed plan executes
      // without the user typing anything, so it starts while they are reading.
      onWorkerOutput: line => ui.warning(line),
      // The pool is the ceiling on real parallelism, so the arrangement's own
      // two sandbox numbers have to reach it — not just the scheduler.
      maxWorkers: resolveMaxWorkers(options.concurrency),
      maxIdleWorkers: sessionParams.warmSandboxes,
    })
    notifySandboxClose()
    // The enforced case says nothing: nothing has gone wrong, and the status
    // row already shows the run is live. The unenforced case is the one that
    // needs a line, because it is a security fact and not session metadata.
    if (!sandbox.report.enforced) {
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
    // Mark the record finished so the list shows it as done rather than leaving a
    // 'conversing' entry that looks like work still in flight.
    if (lastPersisted && lastPersisted.phase !== 'finished') {
      persistSession(
        'finished',
        lastPersisted.plan ?? null,
        lastPersisted.tasks ?? {},
        {
          fileHashes: lastPersisted.fileHashes ?? {},
          summaryFingerprint: lastPersisted.summaryFingerprint ?? null,
          ...(lastPersisted.git ? { git: lastPersisted.git } : {}),
        },
      )
    }
    sandbox?.close()
    let code = exitCode
    if (isInterrupted() && code === 0) code = 130
    if (isInterrupted()) {
      ui.warning('Session interrupted. Progress has been saved.')
    }
    return { exitCode: code, interrupted: isInterrupted(), exited }
  }

  // Stubs the Developer created this session, and the only paths delete_stub may
  // remove. Session-scoped and cleared with the evidence: once a plan is
  // confirmed a stub is the implementation, not scaffolding.
  const developerStubs = new Set<string>()

  const developerHandle: LaunchHandle =
    sandbox?.handle ?? createToolHandle(projectDir, { cache: toolCache, stubs: developerStubs })

  // Observability must never be able to fail a run — see safeAgentEmitter.
  const emitAgent = safeAgentEmitter(ui)

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

    // So `finish` can mark the resumed record finished, exactly as it would for
    // a session this run created.
    lastPersisted = stored
    const restored = loadMessages(stored.sessionId, projectDir)
    messages.push(...(restored as unknown as ChatMessage[]))
    resumedPhase = plan.phase
    resumedPlan = stored.plan
    resumedCompleted = new Set(plan.completed)
    ui.info(`Resumed session ${stored.sessionId} (${plan.completed.length} task(s) already done).`)
    replayHistory(ui, restored as unknown as ChatMessage[])
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
    persistSession(
      'awaiting-approval',
      plan,
      Object.fromEntries(plan.tasks.map(t => [t.id, { status: 'pending' as const }])),
    )
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
      if (isUserExit(initialMessage)) ui.info('Goodbye!')
      exited = true
      return finish(0)
    }
    initialKind = 'reentry'
    initialMessage = await ui.askInitialTask(initialKind)
  }

  if (!resuming) {
    // The phase still goes out — it is what puts the status row on "scanning"
    // and keeps the elapsed counter ticking. The two lines that also went out
    // did not: "Scanning project in …" and "Starting conversation with
    // developer…" restated what the screen was already showing, in a place the
    // user reads as the conversation, above the first thing they said. The
    // agent's own first line is what should be at the top of a transcript.
    emitAgent({ type: 'phase', agent: { role: 'developer' }, phase: 'scanning' })
  }

  let result: DeveloperTurnResult | undefined
  let userMessage = initialMessage ?? ''

  // §3: a session that stopped short of running anything re-presents its plan
  // instead of asking the Developer to plan all over again.
  let preselected: DeveloperTurnResult | null =
    resumedPhase === 'awaiting-approval' && resumedPlan ? { type: 'plan', plan: resumedPlan } : null
  // Mid-execution: go straight back into the work that did not finish.
  if (resumedPhase === 'executing' && resumedPlan) {
    preselected = { type: 'plan', plan: resumedPlan }
    options.autoConfirm = true
  }

  // A resumed conversation with no plan to replay starts at the prompt.
  // Without this, userMessage is '' and turn 1 sends an empty user turn to
  // the model — which then "replies" to nothing and pollutes the transcript.
  /** The last execution report's code, returned if the user leaves after it. */
  let lastExecutionExitCode: number | null = null

  if (resuming && !preselected && !userMessage) {
    userMessage = await ui.askUserMessage()
    if (!userMessage) {
      ui.warning('Empty message. Type "exit" to quit.')
      userMessage = 'exit'
    }
    if (isExitCommand(userMessage)) {
      if (isUserExit(userMessage)) ui.info('Goodbye!')
      exited = true
      return finish(0)
    }
  }

  // Evidence the plan validator checks against, owned here so a plan rejected
  // in one turn can be re-proposed in the next. Reset before execution begins —
  // see resetEvidenceLedger.
  const planEvidence = createEvidenceLedger()

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
          model: developerModel,
          reasoningEffort: roleReasoning(developerModel),
          apiKey: options.apiKey,
          handle: developerHandle,
          messages,
          summaryIndex,
          evidence: planEvidence,
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
          if (isUserExit(userMessage)) ui.info('Goodbye!')
          exited = true
          return finish(0)
        }
        continue
      }

      ui.info('\n🚀 Executing tasks...\n')

      // The Workers are about to change the files the planning evidence
      // describes. Anything recorded before this point is stale the moment the
      // first write lands, so a post-execution planning turn must collect its
      // own evidence rather than trust this. A stub created here is now the
      // implementation, so it stops being retractable at the same moment.
      resetEvidenceLedger(planEvidence)
      developerStubs.clear()

      // Everything from here to the report is the arrangement of Workers, and
      // it no longer needs the conversation: `executePlan` runs a plan given to
      // it, whoever planned it.
      const execution = await executePlan(result.plan, sessionParams, options, ui, {
        sessionId,
        sandbox,
        registry,
        masterAgentId: masterAgent.id,
        toolCache,
        changeHistory,
        fileLocks,
        commandResourceLocks,
        persistSession,
        ...(options.sampler ? { sampler: options.sampler } : {}),
        ...(resumedCompleted.size > 0 ? { alreadyCompleted: resumedCompleted } : {}),
        ...(managerAsks
          ? {
              managerDecision: {
                model: managerModel,
                asks: true,
                reasoningEffort: roleReasoning(managerModel),
              },
            }
          : {}),
      })

      if (execution.aborted) {
        ui.warning(`Manager stopped the plan: ${execution.abortedReason ?? 'aborted'}`)
      }

      if (options.continueAfterExecution) {
        // The outcome becomes the next planning input: what each task did, and
        // the first line of whatever went wrong for the ones that did not.
        const outcomes = execution.tasks
          .map((t) => {
            const detail = t.error ? ` — ${t.error.split('\n')[0].slice(0, 160)}` : ''
            return `- ${t.id} [${t.status}] ${t.title}${detail}`
          })
          .join('\n')
        messages.push({
          role: 'user',
          content: [
            '<execution-report>',
            `The plan ran. ${execution.report.lines.join(' ')}`,
            outcomes,
            '</execution-report>',
            execution.report.exitCode === 0
              ? 'If the user asks for more, propose a new plan for it.'
              : 'Some tasks failed. If the user asks for another attempt, re-read the ' +
                'failing files and propose a corrected plan rather than repeating this one.',
          ].join('\n'),
        })
        lastExecutionExitCode = execution.report.exitCode
      } else {
        return finish(execution.report.exitCode)
      }
    }

    userMessage = await ui.askUserMessage()

    if (!userMessage) {
      ui.warning('Empty message. Type "exit" to quit.')
      userMessage = 'exit'
    }

    if (isExitCommand(userMessage)) {
      if (isUserExit(userMessage)) ui.info('Goodbye!')
      exited = true
      // A run whose tasks failed still failed, even if the user then asked
      // about it: the exit code is the report's, not the chat's.
      return finish(lastExecutionExitCode ?? 0)
    }
  }

  if (turn >= MAX_CONVERSATION_TURNS && !isInterrupted() && result?.type !== 'plan') {
    // D9: we did not start execution after the turn cap — don't claim we did.
    ui.warning('Reached the 20-turn conversation limit. Continuing may be limited.')
  }

  return finish(0)
}

/**
 * Run a confirmed plan to its report.
 *
 * This is the arrangement of Workers and nothing else: no Developer turn, no
 * prompt, no conversation. `runSession` calls it once a plan is confirmed, and
 * `vajra bench` calls it with a plan read off disk, so a tuning run and a real
 * session schedule tasks through the same code.
 *
 * Every knob comes from `params` and from nowhere else — not from a flag, not
 * from `~/.vajra/config.json`, not from a default in this file. `runSession`
 * resolves the two values a user can set on the command line and hands them over
 * in `sessionParams`; `vajra bench` hands over the loaded `bench/config.json`.
 */
export async function executePlan(
  plan: DeveloperPlan,
  params: WorkerParams,
  options: SessionOptions,
  ui: SessionUI,
  deps: ExecutePlanDeps = {},
): Promise<ExecutePlanResult> {
  if (!options.apiKey) {
    throw new Error(`No API key for worker model '${params.workerModel}'`)
  }
  // Narrowed here so the per-task closure below sees a definite string.
  const apiKey = options.apiKey
  const projectDir = resolve(options.projectDir)
  if (!existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`)
  }

  const sandbox = deps.sandbox ?? null
  const sessionId = deps.sessionId ?? randomUUID()
  const registry = deps.registry ?? new AgentRegistry()
  const masterAgentId =
    deps.masterAgentId ?? registry.createAgent(sessionId, 'master', 'Orchestrate task execution').id
  const toolCache = deps.toolCache ?? { read: new Map(), generation: 0 }
  const changeHistory = deps.changeHistory ?? new ChangeHistory(projectDir)
  const fileLocks = deps.fileLocks ?? new FileLockManager()
  const commandResourceLocks = deps.commandResourceLocks ?? new FileLockManager()
  const persistSession = deps.persistSession
  const manager = deps.managerDecision
  const abortSignal = options.signal ?? new AbortController().signal
  const isInterrupted = () => abortSignal.aborted
  const emitAgent = safeAgentEmitter(ui)

  // No Worker count: CPU and RAM decide, unless a session passed --concurrency.
  const maxWorkers = resolveMaxWorkers(options.concurrency)
  const workerModel = params.workerModel
  const governor = new Governor(params, deps.sampler)

  /**
   * Each running task's pause switch. The governor's decision reaches a Worker
   * in two halves: the gate stops its model loop here, and the sandbox freezes
   * the commands it is running.
   */
  const pauseGates = new Map<string, PauseGate>()
  /** Each Worker's last phase, so a resumed Worker shows what it was doing. */
  const workerPhases = new Map<string, AgentPhase>()
  const emitWorker = (event: AgentEvent): void => {
    if (event.type === 'phase' && event.agent.role === 'worker' && event.agent.taskId && event.phase !== 'paused') {
      workerPhases.set(event.agent.taskId, event.phase)
    }
    emitAgent(event)
  }
  const workerLabel = (task: TaskState) => ({ role: 'worker' as const, taskId: task.id, title: task.title })

  // D3: queue default timeout comes from the CLI -t flag (seconds).
  const queue = new TaskQueue(sessionId, options.timeout ?? 300)
  for (const task of plan.tasks) {
    const state = queue.addTask(task)
    // `retries` is the run's policy for every task. A plan's own value is
    // ignored: a sweep varies the arrangement, and a plan that quietly asked
    // for a different number of attempts would make two candidates incomparable.
    state.maxRetries = params.retries
  }

  // §3: a mid-execution resume re-runs only what did not complete. The
  // completed tasks stay recorded as done so the final report is honest
  // about what this session actually did.
  const alreadyCompleted = deps.alreadyCompleted ?? new Set<string>()
  if (alreadyCompleted.size > 0) {
    for (const taskId of alreadyCompleted) {
      if (!queue.getTask(taskId)) continue
      queue.markAlreadyDone(taskId)
    }
    ui.info(
      `Skipping ${alreadyCompleted.size} task(s) that already completed in a previous run.`,
    )
  }

  // Computed once: the staleness gate and the index cache need these, and
  // a repo walk or a git call on every task transition would be absurd.
  const summaryFingerprint = repoFingerprint(projectDir)
  const gitState = readGitState(projectDir)

  const allTaskFilePaths = (): string[] => {
    const paths = new Set<string>()
    for (const t of queue.getAllTasks()) {
      for (const lease of taskLeases(t, params.readLocks, projectDir)) {
        paths.add(lease.path)
      }
    }
    return [...paths]
  }
  const taskFilePaths = (task: TaskState): string[] =>
    taskLeases(task, params.readLocks, projectDir).map(lease => lease.path)
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

  /**
   * What each completed task published, and what each failed attempt left.
   *
   * Both are in memory and in the run's result, not in the session store: a
   * tuning run must not leave ten records per suite, and a handoff is only
   * meaningful for the run it belongs to — the files it names are changed again
   * by the next run.
   */
  const handoffs = new Map<string, Handoff>()
  const attempts = new Map<string, AttemptRecord[]>()

  /**
   * How this project is built and checked, read off its manifests once.
   *
   * Built here rather than per Worker because it is the same for all of them:
   * every pack in a run carries one card, so a Worker never spends a round
   * discovering how the tests are run.
   */
  const projectCard = buildProjectCard(projectDir)

  /**
   * The before and after of every file an attempt is on record for changing.
   *
   * Read now, because the rollback that follows a failed attempt deletes the
   * evidence: a diff captured afterwards would show nothing. `undefined` from
   * the ledger means no baseline was recorded, and there is no honest diff to
   * write for that file.
   */
  const attemptContent = (
    task: TaskState,
  ): { files: string[]; before: Map<string, string | null>; after: Map<string, string | null> } => {
    const files = changeHistory.getTaskFiles(task.id)
    const before = new Map<string, string | null>()
    const after = new Map<string, string | null>()
    for (const path of files) {
      const original = changeHistory.getOriginalContent(task.id, path)
      if (original === undefined) continue
      before.set(path, original)
      try {
        after.set(path, readFileSync(resolve(projectDir, path), 'utf-8'))
      } catch {
        after.set(path, null)
      }
    }
    return { files: [...before.keys()], before, after }
  }

  const diffOfAttempt = (task: TaskState): string => {
    const { files, before, after } = attemptContent(task)
    return diffsWithin(
      files.map((path): DiffFile => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null })),
      params.respawnDiffChars,
    )
  }

  /**
   * The handoffs a task starts from: its direct dependencies in full, and the
   * rest as interfaces only.
   *
   * Split that way because a transitive handoff describes code written against a
   * tree this task is not looking at, while the declarations it established are
   * exactly what a caller two steps away needs.
   */
  const upstreamOf = (
    task: TaskState,
  ): { direct: Handoff[]; transitive: Handoff[] } | undefined => {
    const direct: Handoff[] = []
    for (const id of task.dependsOn) {
      const handoff = handoffs.get(id)
      if (handoff) direct.push(handoff)
    }
    const transitive: Handoff[] = []
    const seen = new Set(task.dependsOn)
    const frontier = [...task.dependsOn]
    while (frontier.length > 0) {
      const id = frontier.shift() as string
      for (const depId of queue.getTask(id)?.dependsOn ?? []) {
        if (seen.has(depId)) continue
        seen.add(depId)
        const handoff = handoffs.get(depId)
        if (handoff) transitive.push(handoff)
        frontier.push(depId)
      }
    }
    return direct.length === 0 && transitive.length === 0 ? undefined : { direct, transitive }
  }

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

      persistSession?.(
        isInterrupted() ? 'finished' : 'executing',
        plan,
        tasks,
        {
          fileHashes: { ...fileHashes },
          summaryFingerprint,
          ...(gitState ? { git: gitState } : {}),
        },
        Number.isFinite(maxWorkers) ? maxWorkers : undefined,
      )
    } catch (e) {
      ui.warning(
        `Could not persist session state: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  // Plan accepted — record every task as pending before anything runs.
  persist()

  /**
   * Acquire a task's leases, one path at a time, in path order.
   *
   * The order is the load-bearing part. Two tasks that each want two of the
   * same files can only wait on each other if they take the files in opposite
   * orders, so taking them in one global order (sorted by path) means a task
   * that is waiting holds nothing a peer is waiting for — and there is no cycle
   * to deadlock on. A blanket `acquireOrWait` over the whole set is not
   * available here: under `shared` a task's reads and its writes want different
   * modes, and grouping them by mode reintroduces exactly that cycle.
   *
   * With `exclusive` every path is a write lease, so this is the same set of
   * locks as before, taken one call at a time and in the same order every time.
   */
  const acquireLeases = async (task: TaskState): Promise<void> => {
    const leases = [...taskLeases(task, params.readLocks, projectDir)].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )
    for (const lease of leases) {
      await fileLocks.acquireOrWait([lease.path], task.id, lease.mode)
    }
  }

  /**
   * Whether every lease this task needs is free right now.
   *
   * Checked per lease for the same reason acquisition is per lease: under
   * `shared` a task may hold reads on a file a peer is reading, so one blanket
   * `write` check would refuse an admission that has no conflict in it.
   */
  const canAcquireLeases = (task: TaskState): boolean =>
    taskLeases(task, params.readLocks, projectDir).every(lease =>
      fileLocks.canAcquire([lease.path], lease.mode, task.id),
    )

  /**
   * One attempt of one task, end to end. Everything it owns (dirty flag,
   * permissions, handle scope, locks) is torn down on every exit path, and
   * a throw fails *this* task only — peers keep their changes.
   *
   * The retry policy is not here: the Manager decides whether this gets another
   * attempt. This returns whether the attempt succeeded.
   */
  const runTaskOnce = async (task: TaskState): Promise<boolean> => {
    let agent: AgentState | null = null
    let dirty = false
    try {
      const allTaskFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
      // D4: wait for locks instead of permanently skipping on conflict.
      await acquireLeases(task)

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
        const skipResult = await evaluateSkipIfDetailed(
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
        for (const w of skipResult.warnings) ui.warning(`⚠ ${w}`)
        const shouldSkip = skipResult.shouldSkip
        if (shouldSkip) {
          queue.skipTask(task.id)
          persist(task)
          ui.onTaskEvent({ type: 'skipped', taskId: task.id, title: task.title })
          return true
        }
      }

      agent = registry.createAgent(sessionId, 'worker', task.title, masterAgentId)
      taskAgents.set(task.id, agent.id)
      queue.assignTask(task.id, agent.id)
      registry.updateStatus(agent.id, 'running')
      queue.startTask(task.id)

      // Progress label derived from the queue: terminal + in-flight counts
      // are still meaningful when tasks start and finish interleaved.
      const progress = queue.getStatus()
      ui.onTaskEvent({
        type: 'start',
        taskId: task.id,
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
      const gate = new PauseGate()
      pauseGates.set(task.id, gate)
      const upstream = upstreamOf(task)
      const earlier = attempts.get(task.id) ?? []
      // What the Worker did with the attempt, once the Worker has ended it.
      let attemptEnd: Omit<AttemptRecord, 'attempt' | 'diff'> | undefined
      const workerContext: WorkerContext = {
        ...(plan.contracts && plan.contracts.length > 0 ? { contracts: plan.contracts } : {}),
        projectCard,
        ...(upstream ? { upstream } : {}),
        ...(earlier.length > 0 ? { previousAttempts: earlier } : {}),
        onAttemptEnd: record => {
          attemptEnd = record
        },
      }
      const success = await executeTask(
        agent.id,
        task,
        taskHandle,
        apiKey,
        workerModel,
        ui,
        changeHistory,
        queue,
        registry,
        sessionId,
        fileLocks,
        projectDir,
        abortSignal,
        emitWorker,
        params,
        gate,
        workerContext,
      )

      // The record of this attempt, read off disk while its changes are still
      // there. The rollback below is what makes the retry start from a clean
      // tree, and it is also what would erase this evidence.
      const recorded: AttemptRecord = {
        attempt: earlier.length + 1,
        ...(attemptEnd ?? { outcome: success ? 'done' : 'error', filesWritten: [] }),
        ...(success ? {} : { diff: diffOfAttempt(task) }),
      }
      attempts.set(task.id, [...earlier, recorded])
      if (success && attemptEnd) {
        const { before, after } = attemptContent(task)
        handoffs.set(
          task.id,
          buildHandoff({
            taskId: task.id,
            title: task.title,
            filesWritten: attemptEnd.filesWritten,
            before,
            after,
            summary: attemptEnd.summary ?? '',
            maxSummaryChars: params.handoffSummaryChars,
          }),
        )
      }

      const noChanges = !dirty && !changeHistory.hasChanges(task.id)
      if (noChanges && !success) {
        ui.onTaskEvent({ type: 'no-changes', taskId: task.id, title: task.title })
      }

      if (success) {
        queue.completeTask(task.id, true)
        registry.updateStatus(agent.id, 'done')
        persist(task)
        ui.onTaskEvent({ type: 'done', taskId: task.id, title: task.title })
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
        ui.onTaskEvent({ type: 'failed', taskId: task.id, title: task.title })
      }
      if (agent) registry.updateStatus(agent.id, 'failed')
      persist(task)
      ui.error(`Task failed: ${task.title} — ${message}`)
      return false
    } finally {
      // Load-bearing under concurrency: a lock leaked here deadlocks every
      // peer waiting on those paths until the process is killed.
      fileLocks.release(task.id)
      // An attempt that ends while paused (an interrupt) must not leave its gate
      // shut for the scheduler to find; release thaws the sandbox side.
      pauseGates.get(task.id)?.resume()
      pauseGates.delete(task.id)
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
    params,
    resources: {
      governor,
      pauseTask: task => {
        const gate = pauseGates.get(task.id)
        if (!gate || gate.paused) return false
        gate.pause()
        sandbox?.pauseTask(task.id)
        emitAgent({ type: 'phase', agent: workerLabel(task), phase: 'paused' })
        return true
      },
      resumeTask: task => {
        const gate = pauseGates.get(task.id)
        if (!gate?.paused) return
        sandbox?.resumeTask(task.id)
        gate.resume()
        emitAgent({ type: 'phase', agent: workerLabel(task), phase: workerPhases.get(task.id) ?? 'executing' })
      },
    },
    isInterrupted,
    defaultMaxRetries: params.retries,
    runTask: runTaskOnce,
    taskWasNoOp: id => noOpTasks.has(id),
    rollbackTask: async task => {
      // Honour the plan's own rollback commands first — without this the
      // `rollback` field in a plan is decorative.
      if (task.rollback && task.rollback.length > 0) {
        const handle = withCommandResourceLock(
          sandbox?.handle ?? createToolHandle(projectDir, { cache: toolCache }),
          commandResourceLocks,
          task.id,
        )
        const result = await runRollbackCommands(task.rollback, handle)
        if (result.failed.length > 0) {
          ui.warning(`Rollback command failed for ${task.title}: ${result.failed[0]}`)
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
        ui.onTaskEvent({ type: 'failed', taskId: task.id, title: task.title })
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
      if (!canAcquireLeases(task)) return false
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
      return commandResourceLocks.canAcquire(resourcePaths, 'write', task.id) &&
        (serverPath === null || fileLocks.canAcquire([serverPath], 'write', task.id))
    },
    ...(manager?.asks
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
                      model: manager.model,
                      reasoningEffort: manager.reasoningEffort,
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

  // The score of a bench run: first Worker spawned to last task completed. A
  // plan whose every task was already done never spawned one, and is 0ms.
  const started = queue
    .getAllTasks()
    .map(task => task.startedAt)
    .filter((at): at is number => at !== null)
  const ended = queue
    .getAllTasks()
    .map(task => task.completedAt)
    .filter((at): at is number => at !== null)
  const wallMs = started.length > 0 && ended.length > 0
    ? Math.max(...ended) - Math.min(...started)
    : 0

  return {
    exitCode: report.exitCode,
    report,
    aborted: masterResult.aborted,
    ...(masterResult.abortedReason !== undefined
      ? { abortedReason: masterResult.abortedReason }
      : {}),
    maxWorkers,
    tasks: queue.getAllTasks().map(task => {
      const error = taskErrors.get(task.id)
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        ...(error !== undefined ? { error } : {}),
      }
    }),
    wallMs,
  }
}
