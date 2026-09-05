import { AgentStatePayload } from '@vajra/protocol'

interface WorkerStatusProps {
  agents: AgentStatePayload[]
}

const statusStyles: Record<string, string> = {
  pending: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400',
  running: 'bg-blue-200 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  done: 'bg-green-200 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-200 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

const roleLabels: Record<string, string> = {
  manager: 'Manager',
  master: 'Master',
  worker: 'Worker',
}

export function WorkerStatus({ agents }: WorkerStatusProps) {
  if (agents.length === 0) return null

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <h3 className="mb-3 text-sm font-semibold text-neutral-900 dark:text-white">
        Agent Status
      </h3>
      <div className="space-y-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-750"
          >
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[agent.status]}`}
            >
              {roleLabels[agent.role] || agent.role}
            </span>
            <span className="flex-1 truncate text-sm text-neutral-900 dark:text-white">
              {agent.taskSummary || agent.id.slice(0, 8)}
            </span>
            <span
              className={`h-2 w-2 rounded-full ${
                agent.status === 'running'
                  ? 'animate-pulse bg-blue-500'
                  : agent.status === 'done'
                  ? 'bg-green-500'
                  : agent.status === 'failed'
                  ? 'bg-red-500'
                  : 'bg-neutral-400'
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
