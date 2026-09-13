import { PlannedTask, TaskStatus } from '@codekalakaars/protocol'
interface PlanViewProps { tasks: PlannedTask[]; taskStates?: Map<string, TaskStatus> }
const typeIcons: Record<string, string> = { create: '+', modify: '~', delete: '-', refactor: 'R' }

export function PlanView({ tasks, taskStates }: PlanViewProps) {
  if (tasks.length === 0) return null
  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid #2a2a2a', background: '#1a1a1a' }}>
      <h3 className="mb-3 text-sm font-semibold" style={{ color: '#e5e5e5' }}>Execution Plan ({tasks.length} tasks)</h3>
      <div className="space-y-2">
        {tasks.map((task) => {
          const status = taskStates?.get(task.id) || 'pending'
          return (
            <div key={task.id} className="flex items-start gap-2 rounded-md p-2" style={{ border: '1px solid #2a2a2a', background: '#0a0a0a' }}>
              <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded text-xs font-mono font-bold"
                style={{ background: status === 'running' ? '#404040' : '#1a1a1a', color: status === 'running' ? '#e5e5e5' : '#737373' }}>
                {typeIcons[task.type] || '?'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium" style={{ color: '#e5e5e5' }}>{task.title}</div>
                {task.files.length > 0 && <div className="mt-0.5 text-xs" style={{ color: '#737373' }}>{task.files.join(', ')}</div>}
              </div>
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                style={{ background: status === 'running' ? '#404040' : '#1a1a1a', color: status === 'running' ? '#e5e5e5' : '#737373' }}>
                {status}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
