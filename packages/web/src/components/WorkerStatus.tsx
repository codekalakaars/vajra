import { AgentStatePayload } from '@codekalakaars/protocol'

interface WorkerStatusProps {
  agents: AgentStatePayload[]
}

const statusStyles: Record<string, string> = {
  pending: 'bg-zinc-800 text-zinc-500 border-zinc-700',
  running: 'bg-white text-black border-white',
  done: 'bg-zinc-700 text-zinc-400 border-zinc-600',
  failed: 'bg-zinc-800 text-zinc-500 border-zinc-700',
}

const roleLabels: Record<string, string> = {
  manager: 'Manager',
  master: 'Master',
  worker: 'Worker',
}

export function WorkerStatus({ agents }: WorkerStatusProps) {
  if (agents.length === 0) return null

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-3 text-sm font-semibold text-white">
        Agent Status
      </h3>
      <div className="space-y-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center gap-3 rounded-md border border-zinc-800 bg-black p-2"
          >
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${statusStyles[agent.status]}`}
            >
              {roleLabels[agent.role] || agent.role}
            </span>
            <span className="flex-1 truncate text-sm text-white">
              {agent.taskSummary || agent.id.slice(0, 8)}
            </span>
            <span
              className={`h-2 w-2 rounded-full ${
                agent.status === 'running'
                  ? 'animate-pulse bg-white'
                  : agent.status === 'done'
                  ? 'bg-zinc-500'
                  : agent.status === 'failed'
                  ? 'bg-zinc-600'
                  : 'bg-zinc-700'
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
