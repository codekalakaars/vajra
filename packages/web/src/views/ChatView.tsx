import { useState, useRef, useEffect, useCallback } from 'react'
import { useSession } from '../hooks/useSession'
import { StatusBadge } from '../components/StatusBadge'
import { ThinkingBlock } from '../components/ThinkingBlock'
import { MarkdownRenderer } from '../components/MarkdownRenderer'
import { PlanView } from '../components/PlanView'
import { WorkerStatus } from '../components/WorkerStatus'
import { ConflictAlert } from '../components/ConflictAlert'
import { Square } from 'lucide-react'

const C = { bg: '#0a0a0a', raised: '#1a1a1a', overlay: '#222222', border: '#2a2a2a', text: '#e5e5e5', textMuted: '#737373', placeholder: '#525252' }

export function ChatView({ connected }: { connected: boolean }) {
  const session = useSession()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [inputValue, setInputValue] = useState('')
  const lastKeyRef = useRef<{ key: string; time: number }>({ key: '', time: 0 })

  const hasSession = session.sessionId !== null
  const isStreaming = session.status === 'streaming' || session.status === 'creating' || session.status === 'planning' || session.status === 'executing'

  const handleGlobalKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isStreaming) return
    if (e.key === 'Escape' || (e.key === 'c' && e.ctrlKey)) {
      const now = Date.now()
      if (lastKeyRef.current.key === e.key && now - lastKeyRef.current.time < 500) { session.stopSession(); lastKeyRef.current = { key: '', time: 0 } }
      else { lastKeyRef.current = { key: e.key, time: now } }
    }
  }, [isStreaming, session.stopSession])

  useEffect(() => { window.addEventListener('keydown', handleGlobalKeyDown); return () => window.removeEventListener('keydown', handleGlobalKeyDown) }, [handleGlobalKeyDown])
  useEffect(() => { const el = scrollRef.current; if (!el) return; if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) el.scrollTop = el.scrollHeight }, [session.messages, session._streamingText, session.thinkingText])
  useEffect(() => { if (!isStreaming && inputRef.current) inputRef.current.focus() }, [session.status])

  const handleSend = async () => { const t = inputValue.trim(); if (!t || !session.sessionId) return; setInputValue(''); await session.sendMessage(t) }
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }

  const inputStyle = { background: C.raised, border: `1px solid ${C.border}`, color: C.text, outline: 'none' }
  const inputFocus = (e: React.FocusEvent<HTMLTextAreaElement>) => { e.currentTarget.style.borderColor = '#525252' }
  const inputBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => { e.currentTarget.style.borderColor = C.border }

  if (!hasSession) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: C.placeholder }}>
        <div className="text-center">
          <p className="text-lg mb-2">No active project</p>
          <p className="text-sm">Click "New Project" to get started</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div className="w-2 h-2 rounded-full" style={{ background: connected ? '#e5e5e5' : '#333333' }} />
        <span className="text-xs" style={{ color: C.placeholder }}>{connected ? 'Connected' : 'Disconnected'}</span>
        <span style={{ color: C.border }}>·</span>
        <h2 className="text-sm font-medium" style={{ color: C.text }}>Project {session.sessionId!.slice(0, 8)}</h2>
        <StatusBadge status={session.status} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-hidden p-6 space-y-4">
        {(session.status === 'planning' || session.status === 'executing' || session.status === 'confirming') && (
          <div className="space-y-3">
            {session.planTasks.length > 0 && (
              <div>
                <PlanView tasks={session.planTasks} />
                {session.status === 'confirming' && (
                  <div className="mt-4 flex gap-3">
                    <button onClick={() => session.confirmPlan()} className="flex-1 px-4 py-2.5 rounded-lg font-medium transition-colors" style={{ background: C.overlay, color: C.text }}>Confirm & Execute</button>
                    <button onClick={() => session.rejectPlan()} className="px-4 py-2.5 rounded-lg transition-colors" style={{ background: C.raised, color: C.textMuted }}>Keep Talking</button>
                  </div>
                )}
              </div>
            )}
            {session.agents.length > 0 && <WorkerStatus agents={session.agents} />}
            {session.conflicts.length > 0 && <ConflictAlert conflicts={session.conflicts} />}
          </div>
        )}

        {session.status === 'idle' && session.messages.length === 0 && <div className="text-center mt-20" style={{ color: C.placeholder }}>Start a conversation to plan your task...</div>}

        {session.messages.map((msg, i) => (
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
                <div className="flex-1 min-w-0">
                  {msg.thinking && <ThinkingBlock text={msg.thinking} />}
                  <MarkdownRenderer content={msg.content} />
                </div>
              </div>
            )}
          </div>
        ))}

        {session.thinkingText && <ThinkingBlock text={session.thinkingText} defaultOpen />}

        {session._streamingText && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0" style={{ background: C.overlay, color: C.text }}>V</div>
            <div className="flex-1 min-w-0"><MarkdownRenderer content={session._streamingText} /></div>
          </div>
        )}

        {session.error && <div className="p-3 rounded text-sm" style={{ background: C.muted, border: `1px solid ${C.border}`, color: C.textMuted }}>{session.error}</div>}
      </div>

      {isStreaming && (
        <div className="px-4 py-2 flex justify-center" style={{ borderTop: `1px solid ${C.border}` }}>
          <button onClick={session.stopSession} className="px-4 py-1.5 rounded text-sm transition-colors flex items-center gap-2" style={{ background: C.raised, color: C.textMuted }}>
            <Square size={14} />
            Stop <span className="text-xs ml-1" style={{ color: C.placeholder }}>Esc Esc / Ctrl+C Ctrl+C</span>
          </button>
        </div>
      )}

      {!isStreaming && session.status !== 'confirming' && (
        <div className="p-4" style={{ borderTop: `1px solid ${C.border}` }}>
          <div className="max-w-3xl mx-auto flex gap-2">
            <textarea ref={inputRef} value={inputValue} onChange={e => setInputValue(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Message..." rows={1} className="flex-1 px-4 py-2.5 rounded-lg text-sm resize-none" style={{ ...inputStyle, background: C.raised }} onFocus={inputFocus} onBlur={inputBlur} />
            <button onClick={handleSend} disabled={!inputValue.trim()} className="px-4 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50"
              style={{ background: C.overlay, color: C.text }}>Send</button>
          </div>
        </div>
      )}
    </div>
  )
}
