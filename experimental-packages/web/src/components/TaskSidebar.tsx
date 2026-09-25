import { useState } from 'react'
import type { PlannedTask, TaskStatus } from '@codekalakaars/vajra-protocol'
import { CheckCircle2, Circle, Loader2, XCircle, ChevronDown, ChevronRight, Clock, FileText, FilePlus, FileMinus, Terminal } from 'lucide-react'

interface TaskSidebarProps {
  tasks: PlannedTask[]
  taskStates?: Map<string, TaskStatus>
  status: string
}

const statusConfig: Record<string, { icon: typeof Circle; color: string; bg: string; label: string }> = {
  pending: { icon: Circle, color: '#525252', bg: 'transparent', label: 'Pending' },
  running: { icon: Loader2, color: '#60a5fa', bg: '#172554', label: 'Running' },
  done: { icon: CheckCircle2, color: '#4ade80', bg: '#052e16', label: 'Done' },
  failed: { icon: XCircle, color: '#f87171', bg: '#450a0a', label: 'Failed' },
}

const typeColors: Record<string, string> = {
  create: '#4ade80',
  modify: '#60a5fa',
  delete: '#f87171',
  refactor: '#c084fc',
}

function TaskItem({ task, status, index }: { task: PlannedTask; status: string; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const cfg = statusConfig[status] || statusConfig.pending
  const Icon = cfg.icon

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${status === 'running' ? '#2563eb33' : '#1a1a1a'}`, background: status === 'running' ? '#0a0f1a' : '#0a0a0a' }}>
      <div className="flex items-center gap-2 p-2.5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <Icon size={14} style={{ color: cfg.color, flexShrink: 0, ...(status === 'running' ? { animation: 'spin 1s linear infinite' } : {}) }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono" style={{ color: '#525252' }}>#{index + 1}</span>
            <span className="text-xs font-medium truncate" style={{ color: '#e5e5e5' }}>{task.title}</span>
          </div>
        </div>
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: typeColors[task.type] || '#525252' }} />
        {expanded ? <ChevronDown size={12} style={{ color: '#525252' }} /> : <ChevronRight size={12} style={{ color: '#525252' }} />}
      </div>

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5" style={{ borderTop: '1px solid #1a1a1a' }}>
          {task.description && (
            <p className="text-[11px] leading-relaxed mt-2" style={{ color: '#737373' }}>{task.description}</p>
          )}

          {task.instructions && task.instructions.length > 0 && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: '#525252' }}>Steps</div>
              <div className="space-y-0.5 rounded p-1.5" style={{ background: '#111' }}>
                {task.instructions.slice(0, 5).map((inst: string, i: number) => (
                  <div key={i} className="text-[10px] font-mono" style={{ color: '#a3a3a3' }}>
                    <span style={{ color: '#525252' }}>{i + 1}.</span> {inst.length > 60 ? inst.slice(0, 60) + '...' : inst}
                  </div>
                ))}
                {task.instructions.length > 5 && (
                  <div className="text-[10px]" style={{ color: '#525252' }}>+{task.instructions.length - 5} more</div>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-1">
            {task.readFile?.map((f: string) => (
              <span key={`r-${f}`} className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-mono" style={{ color: '#737373', background: '#1a1a1a' }}>
                <FileText size={8} /> {f.split('/').pop()}
              </span>
            ))}
            {task.writeFile?.map((f: string) => (
              <span key={`w-${f}`} className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-mono" style={{ color: '#4ade80', background: '#052e16' }}>
                <FilePlus size={8} /> {f.split('/').pop()}
              </span>
            ))}
            {task.deleteFile?.map((f: string) => (
              <span key={`d-${f}`} className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-mono" style={{ color: '#f87171', background: '#450a0a' }}>
                <FileMinus size={8} /> {f.split('/').pop()}
              </span>
            ))}
          </div>

          {task.validation && task.validation.length > 0 && (
            <div className="flex items-center gap-1 text-[9px] font-mono" style={{ color: '#525252' }}>
              <Terminal size={8} /> {task.validation[0]}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function TaskSidebar({ tasks, taskStates, status }: TaskSidebarProps) {
  if (tasks.length === 0) return null

  const done = tasks.filter(t => taskStates?.get(t.id) === 'done').length
  const running = tasks.filter(t => taskStates?.get(t.id) === 'running').length
  const failed = tasks.filter(t => taskStates?.get(t.id) === 'failed').length
  const progress = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0

  return (
    <div className="h-full flex flex-col" style={{ background: '#0d0d0d', borderLeft: '1px solid #1a1a1a' }}>
      {/* Header */}
      <div className="p-3 flex-shrink-0" style={{ borderBottom: '1px solid #1a1a1a' }}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold" style={{ color: '#e5e5e5' }}>Tasks</h3>
          <span className="text-[10px] font-mono" style={{ color: '#525252' }}>{done}/{tasks.length}</span>
        </div>
        {/* Progress bar */}
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#1a1a1a' }}>
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progress}%`, background: failed > 0 ? '#f87171' : '#2563eb' }} />
        </div>
        <div className="flex items-center gap-3 mt-1.5 text-[10px]" style={{ color: '#525252' }}>
          {running > 0 && <span style={{ color: '#60a5fa' }}>{running} running</span>}
          {done > 0 && <span style={{ color: '#4ade80' }}>{done} done</span>}
          {failed > 0 && <span style={{ color: '#f87171' }}>{failed} failed</span>}
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto scroll-hidden p-2 space-y-1.5">
        {tasks.map((task, i) => (
          <TaskItem key={task.id} task={task} status={taskStates?.get(task.id) || 'pending'} index={i} />
        ))}
      </div>

      {/* Status footer */}
      {(status === 'executing' || status === 'streaming') && (
        <div className="p-2.5 flex-shrink-0" style={{ borderTop: '1px solid #1a1a1a' }}>
          <div className="flex items-center gap-2 text-[10px]" style={{ color: '#737373' }}>
            <Loader2 size={10} style={{ color: '#60a5fa', animation: 'spin 1s linear infinite' }} />
            {status === 'executing' ? 'Executing tasks...' : 'Streaming response...'}
          </div>
        </div>
      )}
    </div>
  )
}
