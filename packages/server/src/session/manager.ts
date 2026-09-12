import { randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db/client.js'
import type { PermissionsConfig, FilePermissions, SessionStatus, SessionListResult, AttachMessage, ManagerPlan, PlannedTask } from '@codekalakaars/vajra-protocol'
import type { FileRule, ResourceLimits } from '@codekalakaars/vajra-sandbox'
import { FileLockManager, resolveConcurrencyConfig } from '@codekalakaars/vajra-sandbox'
import type { ChatProvider, ChatMessage } from '../agent/providers/types.js'
import { managerConversationTurn, type ManagerTurnResult } from '../agent/manager.js'
import { masterLoop } from '../agent/master.js'
import { AgentRegistry } from '../agent/registry.js'
import type { SummaryEntry } from '../agent/summary.js'
import { WorkerPool } from './pool.js'

export interface LaunchJob {
  sessionId: string
  projectDir: string
  permissions: PermissionsConfig
  /** Glob-based file rules evaluated per tool call by the worker. */
  fileRules?: readonly FileRule[]
  /** Default permissions for files with no matching rule. */
  defaultFilePermissions?: FilePermissions
  allowUnenforced: boolean
  /** If set, restricts the worker to only these tools. */
  allowedTools?: string[]
  /** Resource limits for this worker. */
  resourceLimits?: ResourceLimits
}

export interface LaunchHandle {
  /** Send one tool call to the worker and await its result. */
  callTool(tool: string, args: unknown): Promise<unknown>
  stop(): void
}

export interface SandboxReport {
  enforced: boolean
  mechanism: string
  warnings: string[]
}

/**
 * Starts whatever actually confines and runs a session. Slice 2 supplies the
 * real implementation (fork the sandboxed worker, wait for its report).
 * Injected rather than imported directly so this file has zero dependency on
 * how — or whether — a worker process exists yet.
 */
export type SessionLauncher = (
  job: LaunchJob,
  onSandboxReport: (report: SandboxReport) => void,
) => Promise<LaunchHandle>

/**
 * The default launcher until slice 2 lands. Fails closed: a session that
 * cannot be launched is marked `failed`, never silently left running
 * unsandboxed. This is deliberate, not a placeholder to relax later — see
 * the security invariant checklist in the project plan.
 */
export const notImplementedLauncher: SessionLauncher = async () => {
  throw new Error('Session launcher is not implemented yet')
}

export interface CreateSessionInput {
  projectDir: string
  permissions: PermissionsConfig
  task: string
  model: string
  provider: ChatProvider
  allowUnenforced?: boolean
}

export interface PushEvents {
  push(event: string, sessionId: string, payload: unknown): void
}

/** In-memory state for an active conversation session. */
interface ConversationState {
  /** Accumulated LLM conversation history (system + user + assistant + tool messages). */
  history: ChatMessage[]
  /** Summary index for in-memory file search. Built on first turn. */
  summaryIndex: SummaryEntry[]
  /** The plan proposed by the Manager, awaiting user confirmation. */
  proposedPlan?: ManagerPlan
  /** The sandboxed worker handle for file tool dispatch. */
  handle: LaunchHandle
  /** File lock manager for coordinating parallel access. */
  fileLocks: FileLockManager
  /** The chat provider for this session. */
  provider: ChatProvider
}

export class SessionManager {
  private handles = new Map<string, LaunchHandle>()
  private conversations = new Map<string, ConversationState>()
  private pools = new Map<string, WorkerPool>()

  constructor(
    private db: SqliteDb,
    private launcher: SessionLauncher,
    private events: PushEvents,
  ) {}

  /**
   * `subscribe` must be called before the launcher runs, not after `create`
   * returns. The launcher can fail (or report sandbox status) synchronously
   * within this call — with the old plan (subscribe only via a later
   * `session.attach`), no connection exists in the subscriber set yet at
   * that point, so an immediate failure event fires into an empty set and
   * is silently dropped. The caller learns nothing and any listener waiting
   * for that event hangs forever. Subscribing the creating connection here,
   * before invoking the launcher, closes that window.
   */
  async create(
    input: CreateSessionInput,
    subscribe: (sessionId: string) => void,
  ): Promise<{ sessionId: string }> {
    const sessionId = randomUUID()
    const now = Date.now()

    this.db
      .prepare(
        `INSERT INTO sessions (id, project_dir, task, model, status, created_at)
         VALUES (?, ?, ?, ?, 'starting', ?)`,
      )
      .run(sessionId, input.projectDir, input.task, input.model, now)

    subscribe(sessionId)

    // Load permissions: prefer .vajra-sandbox.json (glob-based rules with
    // tool restrictions), fall back to .vajra-perms.json (exact-path rules),
    // then to read-only defaults.
    const { loadPermissions } = await import('../native.js')
    const { loadSandboxConfig, buildLaunchJob } = await import('@codekalakaars/vajra-sandbox')

    let permissions: PermissionsConfig
    let allowedTools: string[] | undefined
    let fileRules: FileRule[] = []

    const sandboxConfig = loadSandboxConfig(input.projectDir)
    if (sandboxConfig) {
      // .vajra-sandbox.json found — use its richer config
      const job = buildLaunchJob(sandboxConfig, sessionId)
      permissions = job.permissions
      allowedTools = job.allowedTools
      fileRules = sandboxConfig.fileRules as FileRule[]
    } else {
      // Fall back to .vajra-perms.json or defaults
      permissions = loadPermissions(input.projectDir) ?? {
        version: 1,
        default: { read: true, write: false, edit: false, delete: false },
        files: {},
      }
    }

    try {
      const handle = await this.launcher(
        {
          sessionId,
          projectDir: input.projectDir,
          permissions,
          allowUnenforced: input.allowUnenforced ?? false,
          allowedTools,
          fileRules,
        },
        (report) => this.recordSandboxReport(sessionId, report),
      )
      this.handles.set(sessionId, handle)

      // Initialize worker pool for parallel task execution
      const concurrency = resolveConcurrencyConfig()
      const pool = new WorkerPool(
        { maxConcurrentWorkers: concurrency.maxConcurrentWorkers, maxIdleWorkers: concurrency.maxIdleWorkers },
        this.launcher,
      )
      this.pools.set(sessionId, pool)

      // Initialize conversation state
      this.conversations.set(sessionId, {
        history: [],
        summaryIndex: [],
        handle,
        fileLocks: new FileLockManager(),
        provider: input.provider,
      })

      // Transition to talking — the user can now chat with the Manager
      this.setStatus(sessionId, 'talking')
      this.events.push('session.statusChanged', sessionId, { status: 'talking' })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus(sessionId, 'failed', now)
      this.events.push('session.failed', sessionId, { message })
    }

    return { sessionId }
  }

  list(): SessionListResult {
    const rows = this.db
      .prepare(`SELECT id, project_dir, task, model, status, created_at FROM sessions ORDER BY created_at DESC`)
      .all() as Array<{ id: string; project_dir: string; task: string; model: string; status: SessionStatus; created_at: number }>

    return rows.map((r) => ({
      id: r.id,
      projectDir: r.project_dir,
      task: r.task,
      model: r.model,
      status: r.status,
      createdAt: r.created_at,
    }))
  }

  attach(sessionId: string) {
    const row = this.db
      .prepare(
        `SELECT id, project_dir, task, model, status, created_at,
                sandbox_enforced, sandbox_mechanism, sandbox_warnings
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          id: string
          project_dir: string
          task: string
          model: string
          status: SessionStatus
          created_at: number
          sandbox_enforced: number | null
          sandbox_mechanism: string | null
          sandbox_warnings: string | null
        }
      | undefined

    if (!row) {
      throw new Error(`No such session '${sessionId}'`)
    }

    const messages = this.db
      .prepare(
        `SELECT seq, role, content, tool_name, tool_call_id, tool_args, tool_result, created_at
         FROM messages WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as Array<{
        seq: number
        role: string
        content: string | null
        tool_name: string | null
        tool_call_id: string | null
        tool_args: string | null
        tool_result: string | null
        created_at: number
      }>

    return {
      session: {
        id: row.id,
        projectDir: row.project_dir,
        task: row.task,
        model: row.model,
        status: row.status,
        createdAt: row.created_at,
      },
      sandbox:
        row.sandbox_enforced === null
          ? null
          : {
              enforced: row.sandbox_enforced === 1,
              mechanism: row.sandbox_mechanism ?? 'none',
              warnings: row.sandbox_warnings ? JSON.parse(row.sandbox_warnings) : [],
            },
      messages: messages.map((m) => ({
        seq: m.seq,
        role: m.role as AttachMessage['role'],
        content: m.content,
        toolName: m.tool_name ?? undefined,
        toolCallId: m.tool_call_id ?? undefined,
        toolArgs: m.tool_args ?? undefined,
        toolResult: m.tool_result ?? undefined,
        createdAt: m.created_at,
      })),
    }
  }

  stop(sessionId: string): void {
    const handle = this.handles.get(sessionId)
    if (handle) {
      handle.stop()
      this.handles.delete(sessionId)
    }

    // Drain the worker pool
    const pool = this.pools.get(sessionId)
    if (pool) {
      pool.drain().catch(() => {}) // Best effort drain
      this.pools.delete(sessionId)
    }

    this.conversations.delete(sessionId)
    this.setStatus(sessionId, 'stopped', Date.now())
  }

  delete(sessionId: string): void {
    const handle = this.handles.get(sessionId)
    if (handle) {
      handle.stop()
      this.handles.delete(sessionId)
    }

    // Drain the worker pool
    const pool = this.pools.get(sessionId)
    if (pool) {
      pool.drain().catch(() => {}) // Best effort drain
      this.pools.delete(sessionId)
    }

    this.conversations.delete(sessionId)
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM plan_steps WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId)
    })
    tx()
    this.events.push('session.deleted', sessionId, { sessionId })
  }

  /**
   * Send a message to the session. Routes based on current status:
   * - `talking`: dispatch to Manager conversation loop
   * - `executing`: dispatch to worker (existing behavior)
   * - `confirming`: reject (user must confirm/reject, not send new messages)
   */
  async sendMessage(sessionId: string, content: string, apiKey: string, provider?: ChatProvider): Promise<void> {
    const status = this.getStatus(sessionId)
    if (!status) throw new Error(`No such session ${sessionId}`)

    if (status === 'confirming') {
      throw new Error('Cannot send messages while plan is awaiting confirmation. Confirm or reject the plan first.')
    }

    if (status === 'talking') {
      await this.sendConversationMessage(sessionId, content, apiKey, provider)
      return
    }

    if (status === 'executing' || status === 'running') {
      // Legacy path: dispatch directly to worker
      await this.sendWorkerMessage(sessionId, content, apiKey, provider)
      return
    }

    throw new Error(`Cannot send message in status '${status}'`)
  }

  /**
   * Confirm the proposed plan. If `editedTasks` is provided, use the
   * user-edited version instead of the originally proposed plan.
   */
  async confirmPlan(sessionId: string, editedTasks?: PlannedTask[], apiKey?: string): Promise<void> {
    const conv = this.conversations.get(sessionId)
    if (!conv || !conv.proposedPlan) {
      throw new Error('No proposed plan to confirm')
    }

    const plan: ManagerPlan = editedTasks
      ? { ...conv.proposedPlan, tasks: editedTasks }
      : conv.proposedPlan

    // Clear the proposed plan
    conv.proposedPlan = undefined

    this.events.push('session.planConfirmed', sessionId, {})
    this.setStatus(sessionId, 'executing')

    // Run master loop in background
    if (apiKey) {
      const row = this.db
        .prepare(`SELECT project_dir, model FROM sessions WHERE id = ?`)
        .get(sessionId) as { project_dir: string; model: string }

      const registry = new AgentRegistry(this.db)
      const pool = this.pools.get(sessionId)

      masterLoop({
        sessionId,
        projectDir: row.project_dir,
        plan,
        model: row.model,
        apiKey,
        provider: conv.provider,
        events: this.events,
        db: this.db,
        registry,
        fileLocks: conv.fileLocks,
        pool,
        launchWorker: async (job) => {
          // Use pool if available, otherwise fall back to direct launch
          if (pool) {
            return pool.acquire({
              sessionId,
              projectDir: job.projectDir,
              permissions: job.permissions,
              allowUnenforced: false,
              allowedTools: job.allowedTools,
            })
          }

          // Fallback: direct launch (no pooling)
          const workerHandle = await this.launcher(
            {
              sessionId,
              projectDir: job.projectDir,
              permissions: job.permissions,
              allowUnenforced: false,
              allowedTools: job.allowedTools,
            },
            (report) => this.recordSandboxReport(sessionId, report),
          )
          return workerHandle
        },
      }).then((result) => {
        this.appendMessage(sessionId, result.summary)
        this.setStatus(sessionId, 'done', Date.now())
        this.events.push('session.completed', sessionId, {})
      }).catch((e) => {
        const message = e instanceof Error ? e.message : String(e)
        this.setStatus(sessionId, 'failed', Date.now())
        this.events.push('session.failed', sessionId, { message })
      })
    }
  }

  /**
   * Reject the proposed plan and return to conversation mode.
   */
  rejectPlan(sessionId: string): void {
    const conv = this.conversations.get(sessionId)
    if (!conv) return

    conv.proposedPlan = undefined
    this.setStatus(sessionId, 'talking')
    this.events.push('session.statusChanged', sessionId, { status: 'talking' })
  }

  // ---- Internal helpers ----

  /**
   * Dispatch a message to the Manager conversation loop.
   */
  private async sendConversationMessage(sessionId: string, content: string, apiKey: string, provider?: ChatProvider): Promise<void> {
    const conv = this.conversations.get(sessionId)
    if (!conv) throw new Error('No conversation state')

    const row = this.db
      .prepare(`SELECT project_dir, model FROM sessions WHERE id = ?`)
      .get(sessionId) as { project_dir: string; model: string }

    const activeProvider = provider ?? conv.provider

    this.events.push('session.statusChanged', sessionId, { status: 'talking' })

    try {
      const result = await managerConversationTurn({
        sessionId,
        projectDir: row.project_dir,
        userMessage: content,
        model: row.model,
        apiKey,
        provider: activeProvider,
        events: this.events,
        db: this.db,
        handle: conv.handle,
        messages: conv.history,
        summaryIndex: conv.summaryIndex,
      })

      if (result.type === 'plan') {
        // Manager called propose_plan — transition to confirming
        conv.proposedPlan = result.plan
        this.setStatus(sessionId, 'confirming')
        this.events.push('session.planProposed', sessionId, { plan: result.plan })
      }
      // If result.type === 'response', the text was already streamed to the user
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus(sessionId, 'failed', Date.now())
      this.events.push('session.failed', sessionId, { message })
    }
  }

  /**
   * Legacy path: dispatch a message directly to the worker agent loop.
   */
  private async sendWorkerMessage(sessionId: string, content: string, apiKey: string, provider?: ChatProvider): Promise<void> {
    const { agentLoop } = await import('../agent/loop.js')

    const conv = this.conversations.get(sessionId)
    const activeProvider = provider ?? conv?.provider

    const row = this.db
      .prepare(`SELECT project_dir, model FROM sessions WHERE id = ?`)
      .get(sessionId) as { project_dir: string; model: string }

    const { loadPermissions } = await import('../native.js')
    const permissions = loadPermissions(row.project_dir) ?? {
      version: 1,
      default: { read: true, write: false, edit: false, delete: false },
      files: {},
    }

    // Re-launch the sandbox worker if the previous one crashed or was stopped
    let handle = this.handles.get(sessionId)
    if (!handle) {
      handle = await this.launcher(
        {
          sessionId,
          projectDir: row.project_dir,
          permissions,
          allowUnenforced: false,
        },
        (report) => this.recordSandboxReport(sessionId, report),
      )
      this.handles.set(sessionId, handle)
    }

    if (!activeProvider) {
      throw new Error('No chat provider available for this session')
    }

    this.setStatus(sessionId, 'running')
    try {
      const result = await agentLoop({
        session: { id: sessionId, projectDir: row.project_dir, task: content, model: row.model },
        apiKey,
        provider: activeProvider,
        handle,
        permissions,
        events: this.events,
        db: this.db,
      })
      this.setStatus(sessionId, 'done', Date.now())
      this.events.push('session.completed', sessionId, { summary: result.summary })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus(sessionId, 'failed', Date.now())
      this.events.push('session.failed', sessionId, { message })
      throw e
    }
  }

  /**
   * Append a message to the session's message log.
   */
  private appendMessage(sessionId: string, content: string): void {
    const seq = this.db
      .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE session_id = ?`)
      .get(sessionId) as { next_seq: number }

    this.db
      .prepare(
        `INSERT INTO messages (session_id, seq, role, content, created_at)
         VALUES (?, ?, 'assistant', ?, ?)`,
      )
      .run(sessionId, seq.next_seq, content, Date.now())
  }

  private recordSandboxReport(sessionId: string, report: SandboxReport): void {
    this.db
      .prepare(
        `UPDATE sessions SET sandbox_enforced = ?, sandbox_mechanism = ?, sandbox_warnings = ? WHERE id = ?`,
      )
      .run(report.enforced ? 1 : 0, report.mechanism, JSON.stringify(report.warnings), sessionId)

    this.events.push('session.sandboxStatus', sessionId, report)
  }

  getStatus(sessionId: string): SessionStatus | undefined {
    const row = this.db
      .prepare(`SELECT status FROM sessions WHERE id = ?`)
      .get(sessionId) as { status: SessionStatus } | undefined
    return row?.status
  }

  private setStatus(sessionId: string, status: SessionStatus, endedAt?: number): void {
    if (endedAt !== undefined) {
      this.db.prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`).run(status, endedAt, sessionId)
    } else {
      this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, sessionId)
    }
  }
}
