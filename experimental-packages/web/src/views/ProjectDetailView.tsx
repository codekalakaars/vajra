import { useEffect, useRef, useState, useMemo } from 'react'
import { useProject } from '../hooks/useProject'
import { StatusBadge } from '../components/StatusBadge'
import { ThinkingBlock } from '../components/ThinkingBlock'
import { MarkdownRenderer } from '../components/MarkdownRenderer'
import { PlanView } from '../components/PlanView'
import { TaskSidebar } from '../components/TaskSidebar'
import { ModelSelector } from '../components/ModelSelector'
import { Square } from 'lucide-react'
import type { PlannedTask } from '@codekalakaars/vajra-protocol'

import { C } from '../lib/theme'

interface ParsedPlan { tasks: PlannedTask[]; independentGroups: string[][]; estimatedWorkers: number }
function tryParsePlan(content: string): ParsedPlan | null {
  try {
    const obj = JSON.parse(content)
    if (obj && Array.isArray(obj.tasks) && obj.tasks.length > 0 && obj.tasks[0].id && obj.tasks[0].title && obj.tasks[0].instructions) {
      return { tasks: obj.tasks, independentGroups: obj.independentGroups || [], estimatedWorkers: obj.estimatedWorkers || 1 }
    }
  } catch {}
  return null
}
function PlanMessage({ content, taskStates }: { content: string; taskStates?: Map<string, 'pending' | 'running' | 'done' | 'failed' | 'assigned' | 'skipped'> }) {
  const plan = useMemo(() => tryParsePlan(content), [content])
  if (!plan) return <MarkdownRenderer content={content} />
  return <PlanView tasks={plan.tasks} taskStates={taskStates} independentGroups={plan.independentGroups} estimatedWorkers={plan.estimatedWorkers} />
}

export function ProjectDetailView({ projectId, connected }: { projectId: string; connected: boolean }) {
  const project = useProject()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [attached, setAttached] = useState(false)

  useEffect(() => {
    let cancelled = false
    project.attach(projectId)
      .then(() => { if (!cancelled) setAttached(true) })
      .catch(() => { if (!cancelled) setAttached(true) })
    return () => { cancelled = true }
  }, [projectId])
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [project.messages, project._streamingText, project.thinkingText])
  useEffect(() => { if (!isStreaming && inputRef.current) inputRef.current.focus() }, [project.status])

  const handleSend = async () => { const t = inputValue.trim(); if (!t) return; setInputValue(''); await project.sendMessage(t) }
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }
  const isStreaming = project.status === 'streaming' || project.status === 'creating' || project.status === 'planning' || project.status === 'executing'

  const inputStyle = { background: C.raised, border: `1px solid ${C.border}`, color: C.text, outline: 'none' }
  const inputFocus = (e: React.FocusEvent<HTMLTextAreaElement>) => { e.currentTarget.style.borderColor = '#525252' }
  const inputBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => { e.currentTarget.style.borderColor = C.border }

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="px-6 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="w-2 h-2 rounded-full" style={{ background: connected ? '#e5e5e5' : C.input }} />
          <span className="text-xs" style={{ color: C.placeholder }}>{connected ? 'Connected' : 'Disconnected'}</span>
          <span style={{ color: C.border }}>·</span>
          <h2 className="text-sm font-medium" style={{ color: C.text }}>Project {projectId.slice(0, 8)}</h2>
          <StatusBadge status={project.status} />
          <div className="ml-auto">
            <ModelSelector model={project.model} onSelect={project.setModel} disabled={project.status === 'streaming' || project.status === 'executing' || project.status === 'planning'} />
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-hidden p-6 space-y-4">
          {!attached && <div className="text-center mt-20" style={{ color: C.placeholder }}>Loading...</div>}
          {attached && project.messages.length === 0 && project.status !== 'streaming' && <div className="text-center mt-20" style={{ color: C.placeholder }}>No messages yet</div>}

          {project.messages.map((msg: { role: string; content: string }, i: number) => (
            <div key={i}>
              {msg.role === 'user' ? (
                <div className="flex items-start gap-3 justify-end">
                  <div className="flex-1 min-w-0 text-right">
                    <div className="inline-block px-4 py-2.5 rounded-lg text-sm whitespace-pre-wrap text-left" style={{ background: C.overlay, color: C.text }}>{msg.content}</div>
                  </div>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0" style={{ background: C.overlay, color: C.textMuted }}>Y</div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0" style={{ background: C.overlay, color: C.text }}>V</div>
                   <div className="flex-1 min-w-0"><PlanMessage content={msg.content} taskStates={project.taskStates} /></div>
                </div>
              )}
            </div>
          ))}

          {project._streamingText && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0" style={{ background: C.overlay, color: C.text }}>V</div>
              <div className="flex-1 min-w-0"><MarkdownRenderer content={project._streamingText} /></div>
            </div>
          )}

          {project.thinkingText && <ThinkingBlock text={project.thinkingText} />}
          {project.error && <div className="p-3 rounded text-sm" style={{ background: C.muted, border: `1px solid ${C.border}`, color: C.textMuted }}>{project.error}</div>}
        </div>

        {project.status === 'confirming' && (
          <div className="p-4" style={{ borderTop: `1px solid ${C.border}`, background: '#0d0d0d' }}>
            <div className="flex gap-3">
              <button onClick={() => project.confirmPlan()} className="flex-1 px-4 py-3 rounded-lg font-semibold text-sm transition-all hover:opacity-90" style={{ background: '#2563eb', color: '#ffffff' }}>
                Confirm & Execute
              </button>
              <button onClick={() => project.rejectPlan()} className="px-4 py-3 rounded-lg text-sm transition-all hover:opacity-90" style={{ background: C.raised, color: C.textMuted, border: `1px solid ${C.border}` }}>
                Keep Talking
              </button>
            </div>
          </div>
        )}

        {isStreaming && project.status !== 'confirming' && (
          <div className="px-4 py-2 flex justify-center" style={{ borderTop: `1px solid ${C.border}` }}>
            <button onClick={project.stopProject} className="px-4 py-1.5 rounded text-sm transition-colors flex items-center gap-2" style={{ background: C.raised, color: C.textMuted }}>
              <Square size={14} />
              Stop <span className="text-xs ml-1" style={{ color: C.placeholder }}>Esc Esc / Ctrl+C Ctrl+C</span>
            </button>
          </div>
        )}

        {!isStreaming && project.status !== 'confirming' && (
          <div className="p-4" style={{ borderTop: `1px solid ${C.border}` }}>
            <div className="flex gap-2">
              <textarea ref={inputRef} value={inputValue} onChange={e => setInputValue(e.target.value)} onKeyDown={handleKeyDown}
                placeholder="Message..." rows={1} className="flex-1 px-4 py-2.5 rounded-lg text-sm resize-none" style={inputStyle} onFocus={inputFocus} onBlur={inputBlur} />
              <button onClick={handleSend} disabled={!inputValue.trim()} className="px-4 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50"
                style={{ background: C.overlay, color: C.text }}>Send</button>
            </div>
          </div>
        )}
      </div>

      {project.planTasks.length > 0 && (
        <TaskSidebar tasks={project.planTasks} taskStates={project.taskStates} status={project.status} />
      )}
    </div>
  )
}
