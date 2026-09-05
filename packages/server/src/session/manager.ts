import { randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db/client.js'
import type { PermissionsConfig, SessionStatus, SessionListResult, AttachMessage } from '@vajra/protocol'
import { agentLoop, type AgentLoopResult } from '../agent/loop.js'

export interface LaunchJob {
  sessionId: string
  projectDir: string
  permissions: PermissionsConfig
  allowUnenforced: boolean
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
  allowUnenforced?: boolean
}

export interface PushEvents {
  push(event: string, sessionId: string, payload: unknown): void
}

export class SessionManager {
  private handles = new Map<string, LaunchHandle>()

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

    // Load permissions from the project's .vajra-perms.json (or use read-only
    // defaults). The client may send an empty {} which, if passed directly to
    // the sandbox worker, would lock down every file including reads.
    const { loadPermissions } = await import('../native.js')
    const permissions = loadPermissions(input.projectDir) ?? {
      version: 1,
      default: { read: true, write: false, edit: false, delete: false },
      files: {},
    }

    try {
      const handle = await this.launcher(
        {
          sessionId,
          projectDir: input.projectDir,
          permissions,
          allowUnenforced: input.allowUnenforced ?? false,
        },
        (report) => this.recordSandboxReport(sessionId, report),
      )
      this.handles.set(sessionId, handle)
      this.setStatus(sessionId, 'running')
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
    this.setStatus(sessionId, 'stopped', Date.now())
  }

  delete(sessionId: string): void {
    const handle = this.handles.get(sessionId)
    if (handle) {
      handle.stop()
      this.handles.delete(sessionId)
    }
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM plan_steps WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId)
    })
    tx()
    this.events.push('session.deleted', sessionId, { sessionId })
  }

  /**
   * Start the agent loop for a session. Reads the session data from SQLite,
   * runs the plan-then-execute loop, and updates the session status on
   * completion or failure.
   *
   * Must be called after the creating connection is subscribed (see `create`).
   * The API key is held in this process — the worker never sees it.
   */
  async startSession(sessionId: string, apiKey: string): Promise<AgentLoopResult> {
    const row = this.db
      .prepare(`SELECT id, project_dir, task, model FROM sessions WHERE id = ?`)
      .get(sessionId) as { id: string; project_dir: string; task: string; model: string } | undefined

    if (!row) {
      throw new Error(`No such session '${sessionId}'`)
    }

    // Load permissions from the project
    const permRow = this.db
      .prepare(`SELECT project_dir FROM sessions WHERE id = ?`)
      .get(sessionId) as { project_dir: string }

    // Use the default permissions — the caller should have set these via
    // savePermissions before creating the session. We read them from the
    // native layer which loads from .vajra-perms.json.
    const { loadPermissions } = await import('../native.js')
    const permissions = loadPermissions(permRow.project_dir) ?? {
      version: 1,
      default: { read: true, write: false, edit: false, delete: false },
      files: {},
    }

    const handle = this.handles.get(sessionId)
    if (!handle) {
      throw new Error(`Session '${sessionId}' has no sandbox worker — the launcher may have failed. Create a new session.`)
    }

    try {
      this.setStatus(sessionId, 'running')
      const result = await agentLoop({
        session: {
          id: sessionId,
          projectDir: row.project_dir,
          task: row.task,
          model: row.model,
        },
        apiKey,
        handle,
        permissions,
        events: this.events,
        db: this.db,
      })
      this.setStatus(sessionId, 'done', Date.now())
      this.events.push('session.completed', sessionId, {})
      return result
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus(sessionId, 'failed', Date.now())
      this.events.push('session.failed', sessionId, { message })
      // Keep the handle alive — the worker process is still running.
      // The user can retry by sending a new message.
      throw e
    }
  }

  async sendMessage(sessionId: string, content: string, apiKey: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT project_dir, model FROM sessions WHERE id = ?`)
      .get(sessionId) as { project_dir: string; model: string } | undefined
    if (!row) throw new Error(`No such session ${sessionId}`)

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

    this.setStatus(sessionId, 'running')
    try {
      const result = await agentLoop({
        session: { id: sessionId, projectDir: row.project_dir, task: content, model: row.model },
        apiKey,
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
