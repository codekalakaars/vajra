import { randomUUID } from 'node:crypto'

export type AgentRole = 'developer' | 'master' | 'worker'
export type AgentStatus = 'pending' | 'running' | 'done' | 'failed'

export interface AgentState {
  id: string
  sessionId: string
  role: AgentRole
  status: AgentStatus
  taskSummary: string | null
  parentAgentId: string | null
  createdAt: number
  endedAt: number | null
}

export class AgentRegistry {
  private agents = new Map<string, AgentState>()

  createAgent(
    sessionId: string,
    role: AgentRole,
    taskSummary: string,
    parentAgentId?: string,
  ): AgentState {
    const id = randomUUID()
    const now = Date.now()

    const state: AgentState = {
      id,
      sessionId,
      role,
      status: 'pending',
      taskSummary,
      parentAgentId: parentAgentId ?? null,
      createdAt: now,
      endedAt: null,
    }

    this.agents.set(id, state)
    return state
  }

  updateStatus(agentId: string, status: AgentStatus): void {
    const agent = this.agents.get(agentId)
    if (!agent) return

    agent.status = status
    if (status === 'done' || status === 'failed') {
      agent.endedAt = Date.now()
    }
  }

  get(agentId: string): AgentState | undefined {
    return this.agents.get(agentId)
  }

  getBySession(sessionId: string): AgentState[] {
    return [...this.agents.values()].filter(a => a.sessionId === sessionId)
  }

  getWorkers(sessionId: string): AgentState[] {
    return this.getBySession(sessionId).filter(a => a.role === 'worker')
  }

  getActiveWorkers(sessionId: string): AgentState[] {
    return this.getBySession(sessionId).filter(
      a => a.role === 'worker' && (a.status === 'pending' || a.status === 'running'),
    )
  }

  clear(): void {
    this.agents.clear()
  }
}
