import { randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db/client.js'
import { stmt } from '../db/statements.js'

export type AgentRole = 'manager' | 'master' | 'worker'
export type AgentStatus = 'pending' | 'running' | 'done' | 'failed'

export interface AgentState {
  id: string
  projectId: string
  role: AgentRole
  status: AgentStatus
  taskSummary: string | null
  parentAgentId: string | null
  createdAt: number
  endedAt: number | null
}

export class AgentRegistry {
  constructor(private db: SqliteDb) {}

  createAgent(
    projectId: string,
    role: AgentRole,
    taskSummary: string,
    parentAgentId?: string,
  ): AgentState {
    const id = randomUUID()
    const now = Date.now()

    stmt(
      this.db,
      `INSERT INTO agents (id, session_id, role, status, task_summary, parent_agent_id, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(id, projectId, role, taskSummary, parentAgentId ?? null, now)

    return {
      id,
      projectId,
      role,
      status: 'pending',
      taskSummary,
      parentAgentId: parentAgentId ?? null,
      createdAt: now,
      endedAt: null,
    }
  }

  updateStatus(agentId: string, status: AgentStatus): void {
    const endedAt = status === 'done' || status === 'failed' ? Date.now() : null
    stmt(
      this.db,
      endedAt
        ? `UPDATE agents SET status = ?, ended_at = ? WHERE id = ?`
        : `UPDATE agents SET status = ? WHERE id = ?`,
    ).run(status, ...(endedAt !== null ? [endedAt, agentId] : [agentId]))
  }

  get(agentId: string): AgentState | undefined {
    const row = stmt(this.db, `SELECT * FROM agents WHERE id = ?`).get(agentId) as
      | {
          id: string
          session_id: string
          role: AgentRole
          status: AgentStatus
          task_summary: string | null
          parent_agent_id: string | null
          created_at: number
          ended_at: number | null
        }
      | undefined

    if (!row) return undefined
    return this.rowToState(row)
  }

  getByProject(projectId: string): AgentState[] {
    const rows = stmt(this.db, `SELECT * FROM agents WHERE session_id = ? ORDER BY created_at`).all(projectId) as Array<{
      id: string
      session_id: string
      role: AgentRole
      status: AgentStatus
      task_summary: string | null
      parent_agent_id: string | null
      created_at: number
      ended_at: number | null
    }>

    return rows.map((r) => this.rowToState(r))
  }

  getWorkers(projectId: string): AgentState[] {
    return this.getByProject(projectId).filter((a) => a.role === 'worker')
  }

  getActiveWorkers(projectId: string): AgentState[] {
    return this.getByProject(projectId).filter(
      (a) => a.role === 'worker' && (a.status === 'pending' || a.status === 'running'),
    )
  }

  deleteByProject(projectId: string): void {
    stmt(this.db, `DELETE FROM agent_messages WHERE session_id = ?`).run(projectId)
    stmt(this.db, `DELETE FROM agents WHERE session_id = ?`).run(projectId)
  }

  private rowToState(row: {
    id: string
    session_id: string
    role: AgentRole
    status: AgentStatus
    task_summary: string | null
    parent_agent_id: string | null
    created_at: number
    ended_at: number | null
  }): AgentState {
    return {
      id: row.id,
      projectId: row.session_id,
      role: row.role,
      status: row.status,
      taskSummary: row.task_summary,
      parentAgentId: row.parent_agent_id,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    }
  }
}
