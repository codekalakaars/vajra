import { useState, useRef, useEffect, useCallback } from 'react'
import { useSession } from '../hooks/useSession'
import { StatusBadge } from '../components/StatusBadge'
import { ThinkingBlock } from '../components/ThinkingBlock'
import { MarkdownRenderer } from '../components/MarkdownRenderer'

const SUMMARIZE_TASK = 'Analyze this project thoroughly. Read all source files, configuration files, and documentation. Provide a comprehensive summary covering: 1) What the project does, 2) Tech stack and dependencies, 3) Directory structure and file purposes, 4) Key architecture and patterns, 5) Entry points and main flows.'

const MODELS = [
  { group: 'Auto (Recommended)', options: [{ value: 'openrouter/free', label: 'Auto-route free models' }] },
  { group: 'Strong (1M context)', options: [
    { value: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B' },
    { value: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B' },
    { value: 'minimax/minimax-m3:free', label: 'MiniMax M3' },
    { value: 'thinkingmachines/inkling:free', label: 'Inkling' },
  ]},
  { group: 'Fast', options: [
    { value: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning' },
    { value: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'Nemotron 3 Nano 30B' },
    { value: 'inclusionai/ling-3.0-flash-fin:free', label: 'Ling 3.0 Flash' },
  ]},
  { group: 'Coding', options: [
    { value: 'poolside/laguna-s-2.1:free', label: 'Laguna S 2.1' },
    { value: 'poolside/laguna-xs-2.1:free', label: 'Laguna XS 2.1' },
    { value: 'cohere/north-mini-code:free', label: 'North Mini Code' },
  ]},
  { group: 'General', options: [
    { value: 'z-ai/glm-5.2:free', label: 'GLM 5.2' },
    { value: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B' },
    { value: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B' },
    { value: 'minimax/minimax-m2.7:free', label: 'MiniMax M2.7' },
  ]},
]

export function ChatView({ connected }: { connected: boolean }) {
  const session = useSession()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [projectDir, setProjectDir] = useState('')
  const [model, setModel] = useState('openrouter/free')
  const [inputValue, setInputValue] = useState('')
  const lastKeyRef = useRef<{ key: string; time: number }>({ key: '', time: 0 })

  // Double-press Esc or Ctrl+C to stop streaming
  const handleGlobalKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isStreaming) return
    if (e.key === 'Escape' || (e.key === 'c' && e.ctrlKey)) {
      const now = Date.now()
      const prev = lastKeyRef.current
      if (prev.key === e.key && now - prev.time < 500) {
        session.stopSession()
        lastKeyRef.current = { key: '', time: 0 }
      } else {
        lastKeyRef.current = { key: e.key, time: now }
      }
    }
  }, [isStreaming, session.stopSession])

  useEffect(() => {
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [handleGlobalKeyDown])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    if (nearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [session.messages, session._streamingText, session.thinkingText])

  useEffect(() => {
    if (!isStreaming && inputRef.current) {
      inputRef.current.focus()
    }
  }, [session.status])

  const handleStart = async () => {
    if (!projectDir.trim()) return
    try {
      await session.createSession({
        projectDir: projectDir.trim(),
        permissions: {},
        model,
      })
    } catch {
      // error is set in session state
    }
  }

  const handleSend = async () => {
    const text = inputValue.trim()
    if (!text || !session.sessionId) return
    setInputValue('')
    await session.sendMessage(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const hasSession = session.sessionId !== null
  const isStreaming = session.status === 'streaming' || session.status === 'creating'

  return (
    <div className="flex flex-col h-full">
      {/* Setup — shown before session starts */}
      {!hasSession && (
        <div className="p-6 max-w-2xl mx-auto w-full">
          <h2 className="text-xl font-bold text-white mb-6">New Session</h2>

          <label className="block text-sm font-medium text-gray-300 mb-1">Project path</label>
          <input
            type="text"
            value={projectDir}
            onChange={(e) => setProjectDir(e.target.value)}
            placeholder="/path/to/project"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 mb-4"
          />

          <label className="block text-sm font-medium text-gray-300 mb-1">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm mb-6 focus:outline-none focus:border-blue-500"
          >
            {MODELS.map((group) => (
              <optgroup key={group.group} label={group.group}>
                {group.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </optgroup>
            ))}
          </select>

          <button
            onClick={handleStart}
            disabled={!projectDir.trim() || isStreaming}
            className="w-full px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium transition-colors disabled:opacity-50"
          >
            {session.status === 'creating' ? 'Analyzing project...' : 'Start'}
          </button>
        </div>
      )}

      {/* Chat area — shown after session starts */}
      {hasSession && (
        <>
          {/* Header */}
          <div className="px-6 py-3 border-b border-gray-800 flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-gray-500">{connected ? 'Connected' : 'Disconnected'}</span>
            <span className="text-gray-700">·</span>
            <h2 className="text-sm font-medium text-white">
              Session {session.sessionId!.slice(0, 8)}
            </h2>
            <StatusBadge status={session.status} />
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-hidden p-6 space-y-4">
            {session.status === 'idle' && session.messages.length === 0 && (
              <div className="text-gray-500 text-center mt-20">Waiting for response...</div>
            )}

            {session.messages.map((msg, i) => (
              <div key={i}>
                {msg.role === 'user' ? (
                  <div className="flex items-start gap-3 justify-end">
                    <div className="flex-1 min-w-0 text-right">
                      <div className="inline-block px-4 py-2.5 bg-gray-700 rounded-lg text-white text-sm whitespace-pre-wrap text-left">
                        {msg.content}
                      </div>
                    </div>
                    <div className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                      Y
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                      V
                    </div>
                    <div className="flex-1 min-w-0">
                      {msg.thinking && <ThinkingBlock text={msg.thinking} />}
                      <MarkdownRenderer content={msg.content} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Live streaming bubble */}
            {session.thinkingText && (
              <ThinkingBlock text={session.thinkingText} defaultOpen />
            )}

            {session._streamingText && (
              <div>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                    V
                  </div>
                  <div className="flex-1 min-w-0">
                    <MarkdownRenderer content={session._streamingText} />
                  </div>
                </div>
              </div>
            )}

            {session.error && (
              <div className="p-3 bg-red-900/30 border border-red-800 rounded text-red-300 text-sm">
                {session.error}
              </div>
            )}
          </div>

          {/* Stop button — shown during streaming */}
          {isStreaming && (
            <div className="px-4 py-2 border-t border-gray-800 flex justify-center">
              <button
                onClick={session.stopSession}
                className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors flex items-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
                Stop
                <span className="text-xs text-gray-500 ml-1">Esc Esc / Ctrl+C Ctrl+C</span>
              </button>
            </div>
          )}

          {/* Input */}
          {!isStreaming && (
            <div className="p-4 border-t border-gray-800">
              <div className="max-w-3xl mx-auto flex gap-2">
                <textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Message..."
                  rows={1}
                  className="flex-1 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleSend}
                  disabled={!inputValue.trim()}
                  className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm text-white transition-colors disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
