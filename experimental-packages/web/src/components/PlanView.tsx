import { useState } from 'react'
import type { PlannedTask, TaskStatus } from '@codekalakaars/vajra-protocol'
import { ChevronDown, ChevronRight, FileText, FilePlus, FileMinus, FolderPlus, Terminal, Clock, Users, Layers, Pencil } from 'lucide-react'

interface PlanViewProps {
  tasks: PlannedTask[]
  taskStates?: Map<string, TaskStatus>
  independentGroups?: string[][]
  estimatedWorkers?: number
}

const typeConfig: Record<string, { icon: React.ReactNode; color: string; bg: string; label: string }> = {
  create: { icon: '+', color: '#4ade80', bg: '#052e16', label: 'Create' },
  modify: { icon: <Pencil size={12} />, color: '#60a5fa', bg: '#172554', label: 'Modify' },
  delete: { icon: '-', color: '#f87171', bg: '#450a0a', label: 'Delete' },
  refactor: { icon: 'R', color: '#c084fc', bg: '#3b0764', label: 'Refactor' },
}

const complexityConfig: Record<string, { color: string; bg: string }> = {
  low: { color: '#4ade80', bg: '#052e16' },
  medium: { color: '#fbbf24', bg: '#422006' },
  high: { color: '#f87171', bg: '#450a0a' },
}

function FileBadge({ file, type }: { file: string; type: 'read' | 'write' | 'delete' | 'dir' }) {
  const config = {
    read: { icon: <FileText size={10} />, color: '#737373', bg: '#1a1a1a' },
    write: { icon: <FilePlus size={10} />, color: '#4ade80', bg: '#052e16' },
    delete: { icon: <FileMinus size={10} />, color: '#f87171', bg: '#450a0a' },
    dir: { icon: <FolderPlus size={10} />, color: '#60a5fa', bg: '#172554' },
  }[type]
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono"
      style={{ color: config.color, background: config.bg, border: `1px solid ${config.color}22` }}>
      {config.icon} {file}
    </span>
  )
}

function TaskCard({ task, status, index }: { task: PlannedTask; status: string; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const type = typeConfig[task.type] || typeConfig.modify
  const complexity = task.complexity ? complexityConfig[task.complexity] : null

  const hasDetails = (task.instructions && task.instructions.length > 0) ||
    (task.readFile && task.readFile.length > 0) ||
    (task.writeFile && task.writeFile.length > 0) ||
    (task.deleteFile && task.deleteFile.length > 0) ||
    (task.createDir && task.createDir.length > 0) ||
    (task.validation && task.validation.length > 0) ||
    (task.dependsOn && task.dependsOn.length > 0) ||
    (task.alternativeApproaches && task.alternativeApproaches.length > 0) ||
    task.validationStrategy ||
    task.description

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #2a2a2a', background: '#0a0a0a' }}>
      {/* Header */}
      <div className="flex items-center gap-2 p-3" style={{ cursor: hasDetails ? 'pointer' : 'default' }}
        onClick={() => hasDetails && setExpanded(!expanded)}>
        {/* Type badge */}
        <span className="flex h-6 w-6 items-center justify-center rounded text-xs font-mono font-bold flex-shrink-0"
          style={{ background: type.bg, color: type.color, border: `1px solid ${type.color}33` }}>
          {type.icon}
        </span>

        {/* Title + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono" style={{ color: '#525252' }}>#{index + 1}</span>
            <span className="text-sm font-medium truncate" style={{ color: '#e5e5e5' }}>{task.title}</span>
          </div>
          {task.description && (
            <div className="text-xs mt-0.5 line-clamp-1" style={{ color: '#737373' }}>{task.description}</div>
          )}
        </div>

        {/* Badges */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {complexity && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ color: complexity.color, background: complexity.bg }}>
              {task.complexity}
            </span>
          )}
          {task.estimatedDuration && (
            <span className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]"
              style={{ color: '#737373', background: '#1a1a1a' }}>
              <Clock size={9} /> {task.estimatedDuration}s
            </span>
          )}
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{
              background: status === 'running' ? '#404040' : status === 'done' ? '#052e16' : '#1a1a1a',
              color: status === 'running' ? '#e5e5e5' : status === 'done' ? '#4ade80' : '#737373',
            }}>
            {status}
          </span>
          {hasDetails && (
            expanded ? <ChevronDown size={14} style={{ color: '#525252' }} /> : <ChevronRight size={14} style={{ color: '#525252' }} />
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2" style={{ borderTop: '1px solid #1a1a1a' }}>
          {/* Description (full) */}
          {task.description && (
            <div className="mt-2 text-xs leading-relaxed" style={{ color: '#a3a3a3' }}>{task.description}</div>
          )}

          {/* Dependencies */}
          {task.dependsOn && task.dependsOn.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#525252' }}>Depends on</div>
              <div className="flex flex-wrap gap-1">
                {task.dependsOn.map((dep: string) => (
                  <span key={dep} className="rounded px-1.5 py-0.5 text-[10px] font-mono"
                    style={{ color: '#fbbf24', background: '#422006', border: '1px solid #fbbf2422' }}>
                    {dep}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Instructions */}
          {task.instructions && task.instructions.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#525252' }}>Instructions</div>
              <div className="space-y-0.5 rounded-md p-2" style={{ background: '#111111' }}>
                {task.instructions.map((inst: string, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs" style={{ color: '#a3a3a3' }}>
                    <span className="font-mono text-[10px] mt-0.5 flex-shrink-0" style={{ color: '#525252' }}>{i + 1}.</span>
                    <span className="font-mono text-[11px]">{inst}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Files */}
          <div className="flex flex-wrap gap-1">
            {task.readFile?.map((f: string) => <FileBadge key={`r-${f}`} file={f} type="read" />)}
            {task.writeFile?.map((f: string) => <FileBadge key={`w-${f}`} file={f} type="write" />)}
            {task.deleteFile?.map((f: string) => <FileBadge key={`d-${f}`} file={f} type="delete" />)}
            {task.createDir?.map((d: string) => <FileBadge key={`dir-${d}`} file={d} type="dir" />)}
          </div>

          {/* Validation */}
          {task.validation && task.validation.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1" style={{ color: '#525252' }}>
                <Terminal size={10} /> Validation
              </div>
              <div className="rounded-md px-2 py-1.5 font-mono text-[11px]" style={{ background: '#111111', color: '#a3a3a3' }}>
                {task.validation.join(' && ')}
              </div>
            </div>
          )}

          {/* Validation strategy */}
          {task.validationStrategy && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#525252' }}>Strategy</span>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-mono"
                style={{ color: '#c084fc', background: '#3b0764', border: '1px solid #c084fc22' }}>
                {task.validationStrategy}
              </span>
            </div>
          )}

          {/* Alternative approaches */}
          {task.alternativeApproaches && task.alternativeApproaches.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#525252' }}>Alternatives</div>
              <div className="space-y-0.5 rounded-md p-2" style={{ background: '#111111' }}>
                {task.alternativeApproaches.map((alt: string, i: number) => (
                  <div key={i} className="text-[11px]" style={{ color: '#737373' }}>• {alt}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function PlanView({ tasks, taskStates, independentGroups, estimatedWorkers }: PlanViewProps) {
  if (tasks.length === 0) return null

  // Determine which tasks are in independent groups for parallel display
  const taskGroupMap = new Map<string, number>()
  if (independentGroups) {
    independentGroups.forEach((group, i) => {
      group.forEach(taskId => taskGroupMap.set(taskId, i))
    })
  }

  // Group tasks by their group index (or show flat list if no groups)
  const hasGroups = independentGroups && independentGroups.length > 0

  return (
    <div className="rounded-xl p-4 space-y-3" style={{ border: '1px solid #2a2a2a', background: '#111111' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: '#e5e5e5' }}>
          <Layers size={14} style={{ color: '#60a5fa' }} />
          Execution Plan
          <span className="text-xs font-normal" style={{ color: '#737373' }}>({tasks.length} tasks)</span>
        </h3>
        <div className="flex items-center gap-3 text-[10px]" style={{ color: '#525252' }}>
          {estimatedWorkers && (
            <span className="flex items-center gap-1"><Users size={10} /> {estimatedWorkers} workers</span>
          )}
          {hasGroups && independentGroups!.length > 1 && (
            <span>{independentGroups!.length} parallel groups</span>
          )}
        </div>
      </div>

      {/* Tasks */}
      {hasGroups ? (
        // Render grouped by parallel groups
        <div className="space-y-2">
          {independentGroups!.map((group, gi) => {
            const groupTasks = group.map(id => tasks.find(t => t.id === id)).filter(Boolean) as PlannedTask[]
            if (groupTasks.length === 0) return null
            return (
              <div key={gi} className="space-y-1">
                {independentGroups!.length > 1 && (
                  <div className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5 px-1"
                    style={{ color: '#525252' }}>
                    <span className="inline-block h-px flex-1" style={{ background: '#2a2a2a' }} />
                    Group {gi + 1} — parallel
                    <span className="inline-block h-px flex-1" style={{ background: '#2a2a2a' }} />
                  </div>
                )}
                {groupTasks.map((task, i) => (
                  <TaskCard key={task.id} task={task} status={taskStates?.get(task.id) || 'pending'}
                    index={tasks.indexOf(task)} />
                ))}
              </div>
            )
          })}
        </div>
      ) : (
        // Flat list
        <div className="space-y-1">
          {tasks.map((task, i) => (
            <TaskCard key={task.id} task={task} status={taskStates?.get(task.id) || 'pending'} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}
