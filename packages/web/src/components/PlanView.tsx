import { PlannedTask, TaskStatus } from '@codekalakaars/protocol'

interface PlanViewProps {
  tasks: PlannedTask[]
  taskStates?: Map<string, TaskStatus>
}

const statusColors: Record<TaskStatus, string> = {
  pending: 'bg-zinc-800 text-zinc-500 border-zinc-700',
  assigned: 'bg-zinc-800 text-zinc-400 border-zinc-700',
  running: 'bg-white text-black border-white',
  done: 'bg-zinc-700 text-zinc-400 border-zinc-600',
  failed: 'bg-zinc-800 text-zinc-500 border-zinc-700',
  skipped: 'bg-zinc-900 text-zinc-600 border-zinc-800',
}

const typeIcons: Record<string, string> = {
  create: '+',
  modify: '~',
  delete: '-',
  refactor: 'R',
}

export function PlanView({ tasks, taskStates }: PlanViewProps) {
  if (tasks.length === 0) return null

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-3 text-sm font-semibold text-white">
        Execution Plan ({tasks.length} tasks)
      </h3>
      <div className="space-y-2">
        {tasks.map((task) => {
          const status = taskStates?.get(task.id) || 'pending'
          return (
            <div
              key={task.id}
              className="flex items-start gap-2 rounded-md border border-zinc-800 bg-black p-2"
            >
              <span
                className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded text-xs font-mono font-bold border ${statusColors[status]}`}
              >
                {typeIcons[task.type] || '?'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white">
                  {task.title}
                </div>
                {task.files.length > 0 && (
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {task.files.join(', ')}
                  </div>
                )}
              </div>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${statusColors[status]}`}
              >
                {status}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
