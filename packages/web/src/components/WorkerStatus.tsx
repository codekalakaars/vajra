import { AgentStatePayload } from '@codekalakaars/protocol'

interface WorkerStatusProps {
  agents: AgentStatePayload[]
}

const roleLabels: Record<string, string> = {
  manager: 'Manager',
  master: 'Master',
  worker: 'Worker',
}

export function WorkerStatus({ agents }: WorkerStatusProps) {
  if (agents.length === 0) return null

  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid #2d2d2d', background: '#20201f' }}>
      <h3 className="mb-3 text-sm font-semibold" style={{ color: '#f7f7f2' }}>
        Agent Status
      </h3>
      <div className="space-y-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center gap-3 rounded-md p-2"
            style={{ border: '1px solid #2d2d2d', background: '#151515' }}
          >
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
              style={{
                background: agent.status === 'running' ? '#d97757' : '#292927',
                color: agent.status === 'running' ? '#151515' : '#a5a39a',
              }}
            >
              {roleLabels[agent.role] || agent.role}
            </span>
            <span className="flex-1 truncate text-sm" style={{ color: '#f7f7f2' }}>
              {agent.taskSummary || agent.id.slice(0, 8)}
            </span>
            <span
              className={`h-2 w-2 rounded-full ${
                agent.status === 'running'
                  ? 'animate-pulse'
                  : ''
              }`}
              style={{
                background: agent.status === 'running' ? '#d97757'
                  : agent.status === 'done' ? '#a5a39a'
                  : agent.status === 'failed' ? '#ef7772'
                  : '#4d4d4c',
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
