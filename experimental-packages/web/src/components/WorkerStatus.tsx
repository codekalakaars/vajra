import { AgentStatePayload } from '@codekalakaars/vajra-protocol'

interface WorkerStatusProps { agents: AgentStatePayload[] }
const roleLabels: Record<string, string> = { developer: 'Developer', master: 'Master', worker: 'Worker' }

export function WorkerStatus({ agents }: WorkerStatusProps) {
  if (agents.length === 0) return null
  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid #2a2a2a', background: '#1a1a1a' }}>
      <h3 className="mb-3 text-sm font-semibold" style={{ color: '#e5e5e5' }}>Agent Status</h3>
      <div className="space-y-2">
        {agents.map((agent) => (
          <div key={agent.id} className="flex items-center gap-3 rounded-md p-2" style={{ border: '1px solid #2a2a2a', background: '#0a0a0a' }}>
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ background: agent.status === 'running' ? '#404040' : '#1a1a1a', color: agent.status === 'running' ? '#e5e5e5' : '#737373' }}>
              {roleLabels[agent.role] || agent.role}
            </span>
            <span className="flex-1 truncate text-sm" style={{ color: '#e5e5e5' }}>
              {agent.taskSummary || agent.id.slice(0, 8)}
            </span>
            <span className={`h-2 w-2 rounded-full ${agent.status === 'running' ? 'animate-pulse' : ''}`}
              style={{ background: agent.status === 'running' ? '#e5e5e5' : agent.status === 'done' ? '#737373' : agent.status === 'failed' ? '#525252' : '#333333' }} />
          </div>
        ))}
      </div>
    </div>
  )
}
