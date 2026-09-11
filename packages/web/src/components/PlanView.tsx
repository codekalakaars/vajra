import { PlannedTask, TaskStatus } from '@vajra/protocol'

interface PlanViewProps {
  tasks: PlannedTask[]
  taskStates?: Map<string, TaskStatus>
}

const statusColors: Record<TaskStatus, string> = {
  pending: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400',
  assigned: 'bg-blue-200 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  running: 'bg-yellow-200 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  done: 'bg-green-200 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-200 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  skipped: 'bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-500',
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
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <h3 className="mb-3 text-sm font-semibold text-neutral-900 dark:text-white">
        Execution Plan ({tasks.length} tasks)
      </h3>
      <div className="space-y-2">
        {tasks.map((task) => {
          const status = taskStates?.get(task.id) || 'pending'
          return (
            <div
              key={task.id}
              className="flex items-start gap-2 rounded-md border border-neutral-100 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-750"
            >
              <span
                className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded text-xs font-mono font-bold ${statusColors[status]}`}
              >
                {typeIcons[task.type] || '?'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-neutral-900 dark:text-white">
                  {task.title}
                </div>
                {task.files.length > 0 && (
                  <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {task.files.join(', ')}
                  </div>
                )}
              </div>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[status]}`}
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
