import { useEffect, useRef } from 'react'
import { useSession } from '../hooks/useSession'
import { StatusBadge } from '../components/StatusBadge'
import { ThinkingBlock } from '../components/ThinkingBlock'
import { MarkdownRenderer } from '../components/MarkdownRenderer'
import { useState } from 'react'

const C = {
  bg: '#151515', raised: '#20201f', overlay: '#292927', border: '#2d2d2d',
  text: '#f7f7f2', textMuted: '#a5a39a', placeholder: '#898781',
  accent: '#d97757', input: '#4d4d4c',
}

export function SessionDetailView({ sessionId, connected }: { sessionId: string; connected: boolean }) {
  const session = useSession()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [attached, setAttached] = useState(false)

  useEffect(() => { session.attach(sessionId).then(() => setAttached(true)) }, [sessionId])
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [session.messages, session._streamingText, session.thinkingText])
  useEffect(() => { if (!isStreaming && inputRef.current) inputRef.current.focus() }, [session.status])

  const handleSend = async () => { const t = inputValue.trim(); if (!t) return; setInputValue(''); await session.sendMessage(t) }
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }
  const isStreaming = session.status === 'streaming'

  const inputStyle = { background: C.raised, border: `1px solid ${C.border}`, color: C.text, outline: 'none' }
  const inputFocus = (e: React.FocusEvent<HTMLTextAreaElement>) => { e.currentTarget.style.borderColor = C.accent }
  const inputBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => { e.currentTarget.style.borderColor = C.border }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div className="w-2 h-2 rounded-full" style={{ background: connected ? C.accent : C.input }} />
        <span className="text-xs" style={{ color: C.placeholder }}>{connected ? 'Connected' : 'Disconnected'}</span>
        <span style={{ color: C.border }}>·</span>
        <h2 className="text-sm font-medium" style={{ color: C.text }}>Session {sessionId.slice(0, 8)}</h2>
        <StatusBadge status={session.status} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-hidden p-6 space-y-4">
        {!attached && <div className="text-center mt-20" style={{ color: C.placeholder }}>Loading...</div>}
        {attached && session.messages.length === 0 && session.status !== 'streaming' && <div className="text-center mt-20" style={{ color: C.placeholder }}>No messages yet</div>}

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
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0" style={{ background: C.accent, color: C.bg }}>V</div>
                <div className="flex-1 min-w-0"><MarkdownRenderer content={msg.content} /></div>
              </div>
            )}
          </div>
        ))}

        {session._streamingText && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0" style={{ background: C.accent, color: C.bg }}>V</div>
            <div className="flex-1 min-w-0"><MarkdownRenderer content={session._streamingText} /></div>
          </div>
        )}

        {session.thinkingText && <ThinkingBlock text={session.thinkingText} />}
        {session.error && <div className="p-3 rounded text-sm" style={{ background: '#3b2020', border: '1px solid #ef7772', color: '#ef7772' }}>{session.error}</div>}
      </div>

      {!isStreaming && (
        <div className="p-4" style={{ borderTop: `1px solid ${C.border}` }}>
          <div className="max-w-3xl mx-auto flex gap-2">
            <textarea ref={inputRef} value={inputValue} onChange={e => setInputValue(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Message..." rows={1} className="flex-1 px-4 py-2.5 rounded-lg text-sm resize-none"
              style={inputStyle} onFocus={inputFocus} onBlur={inputBlur} />
            <button onClick={handleSend} disabled={!inputValue.trim()} className="px-4 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50"
              style={{ background: C.accent, color: C.bg }}>Send</button>
          </div>
        </div>
      )}

      {isStreaming && (
        <div className="px-4 py-2 text-xs flex items-center gap-2" style={{ borderTop: `1px solid ${C.border}`, color: C.placeholder }}>
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: C.accent }} />
          Streaming...
        </div>
      )}
    </div>
  )
}
