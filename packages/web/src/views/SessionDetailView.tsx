import { useEffect, useRef } from 'react'
import { useSession } from '../hooks/useSession'
import { StatusBadge } from '../components/StatusBadge'
import { ThinkingBlock } from '../components/ThinkingBlock'
import { MarkdownRenderer } from '../components/MarkdownRenderer'
import { useState } from 'react'

export function SessionDetailView({ sessionId, connected }: { sessionId: string; connected: boolean }) {
  const session = useSession()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [attached, setAttached] = useState(false)

  useEffect(() => {
    session.attach(sessionId).then(() => setAttached(true))
  }, [sessionId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [session.messages, session._streamingText, session.thinkingText])

  useEffect(() => {
    if (!isStreaming && inputRef.current) {
      inputRef.current.focus()
    }
  }, [session.status])

  const handleSend = async () => {
    const text = inputValue.trim()
    if (!text) return
    setInputValue('')
    await session.sendMessage(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const isStreaming = session.status === 'streaming'

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-3 border-b border-zinc-800 flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${connected ? 'bg-white' : 'bg-zinc-700'}`} />
        <span className="text-xs text-zinc-500">{connected ? 'Connected' : 'Disconnected'}</span>
        <span className="text-zinc-800">·</span>
        <h2 className="text-sm font-medium text-white">
          Session {sessionId.slice(0, 8)}
        </h2>
        <StatusBadge status={session.status} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-hidden p-6 space-y-4">
        {!attached && (
          <div className="text-zinc-600 text-center mt-20">Loading...</div>
        )}

        {attached && session.messages.length === 0 && session.status !== 'streaming' && (
          <div className="text-zinc-600 text-center mt-20">No messages yet</div>
        )}

        {session.messages.map((msg, i) => (
          <div key={i}>
            {msg.role === 'user' ? (
              <div className="flex items-start gap-3 justify-end">
                <div className="flex-1 min-w-0 text-right">
                  <div className="inline-block px-4 py-2.5 bg-zinc-800 rounded-lg text-white text-sm whitespace-pre-wrap text-left">
                    {msg.content}
                  </div>
                </div>
                <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                  Y
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center text-sm font-bold flex-shrink-0">
                  V
                </div>
                <div className="flex-1 min-w-0">
                  <MarkdownRenderer content={msg.content} />
                </div>
              </div>
            )}
          </div>
        ))}

        {session._streamingText && (
          <div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center text-sm font-bold flex-shrink-0">
                V
              </div>
              <div className="flex-1 min-w-0">
                <MarkdownRenderer content={session._streamingText} />
              </div>
            </div>
          </div>
        )}

        {session.thinkingText && (
          <ThinkingBlock text={session.thinkingText} />
        )}

        {session.error && (
          <div className="p-3 bg-zinc-900 border border-zinc-700 rounded text-zinc-400 text-sm">
            {session.error}
          </div>
        )}
      </div>

      {!isStreaming && (
        <div className="p-4 border-t border-zinc-800">
          <div className="max-w-3xl mx-auto flex gap-2">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message..."
              rows={1}
              className="flex-1 px-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-white text-sm placeholder-zinc-600 resize-none focus:outline-none focus:border-white"
            />
            <button
              onClick={handleSend}
              disabled={!inputValue.trim()}
              className="px-4 py-2.5 bg-white hover:bg-zinc-200 rounded-lg text-sm text-black transition-colors disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {isStreaming && (
        <div className="px-4 py-2 border-t border-zinc-800 text-xs text-zinc-600 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
          Streaming...
        </div>
      )}
    </div>
  )
}
