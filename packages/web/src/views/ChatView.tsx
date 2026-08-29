import { useState, useRef, useEffect } from 'react'
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

interface FilePerm {
  read: boolean
  write: boolean
  edit: boolean
  delete: boolean
}

export function ChatView({ connected }: { connected: boolean }) {
  const session = useSession()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Setup state
  const [projectDir, setProjectDir] = useState('')
  const [model, setModel] = useState('openrouter/free')
  const [permissions, setPermissions] = useState<Record<string, FilePerm>>({})
  const [files, setFiles] = useState<Array<{ name: string; path: string; isDir: boolean; isMasked: boolean }>>([])
  const [setupMsg, setSetupMsg] = useState('')
  const [setupMsgColor, setSetupMsgColor] = useState('')
  const [listing, setListing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [permissionsSaved, setPermissionsSaved] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [inputValue, setInputValue] = useState('')

  // Auto-scroll during streaming
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [session.messages, session._streamingText, session.thinkingText])

  // Focus input when done
  useEffect(() => {
    if (session.status === 'done' && inputRef.current) {
      inputRef.current.focus()
    }
  }, [session.status])

  const handleList = async () => {
    if (!projectDir.trim()) return
    setListing(true)
    setSetupMsg('')
    try {
      const result = await session.loadPermissions(projectDir.trim())
      setPermissions(result.permissions)
      setFiles(result.files.filter(f => !f.isDir && !f.isMasked))
      setSetupMsg(`${result.files.filter(f => !f.isDir && !f.isMasked).length} file(s) found. Toggle permissions, then Save or Skip.`)
      setSetupMsgColor('text-gray-400')
    } catch (e) {
      setSetupMsg(String(e))
      setSetupMsgColor('text-red-400')
    } finally {
      setListing(false)
    }
  }

  const handleSave = async () => {
    if (!projectDir.trim()) {
      setSetupMsg('Set a project path first.')
      setSetupMsgColor('text-red-400')
      return
    }
    setSaving(true)
    try {
      await session.savePermissions(projectDir.trim(), permissions)
      setPermissionsSaved(true)
      setSetupMsg('Permissions saved.')
      setSetupMsgColor('text-green-400')
      setShowChat(true)
    } catch (e) {
      setSetupMsg(String(e))
      setSetupMsgColor('text-red-400')
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = () => {
    if (!projectDir.trim()) setProjectDir('/tmp')
    setPermissions({})
    setPermissionsSaved(true)
    setSetupMsg('Skipped — using read-only defaults.')
    setSetupMsgColor('text-gray-500')
    setShowChat(true)
  }

  const handleStart = async () => {
    try {
      await session.createSession({
        projectDir: projectDir.trim(),
        permissions,
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

  const togglePerm = (path: string, key: keyof FilePerm) => {
    setPermissions((prev) => ({
      ...prev,
      [path]: { ...prev[path], [key]: !prev[path]?.[key] },
    }))
  }

  const hasSession = session.sessionId !== null
  const isStreaming = session.status === 'streaming' || session.status === 'creating'

  return (
    <div className="flex flex-col h-full">
      {/* Setup panel — shown before session starts */}
      {!showChat && !hasSession && (
        <div className="p-6 max-w-2xl mx-auto w-full">
          <h2 className="text-xl font-bold text-white mb-6">New Session</h2>

          {/* Project path */}
          <label className="block text-sm font-medium text-gray-300 mb-1">1. Project path</label>
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="/path/to/project"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleList}
              disabled={listing}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-white transition-colors disabled:opacity-50"
            >
              {listing ? 'Listing...' : 'List'}
            </button>
          </div>

          {/* Model */}
          <label className="block text-sm font-medium text-gray-300 mb-1">2. Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm mb-4 focus:outline-none focus:border-blue-500"
          >
            {MODELS.map((group) => (
              <optgroup key={group.group} label={group.group}>
                {group.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </optgroup>
            ))}
          </select>

          {/* Permissions */}
          <label className="block text-sm font-medium text-gray-300 mb-1">3. Permissions</label>
          <div className="border border-gray-700 rounded bg-gray-800/50 max-h-64 overflow-y-auto mb-4">
            {files.length === 0 ? (
              <div className="p-3 text-sm text-gray-500">Click "List" to scan files</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700 text-gray-400">
                    <th className="px-3 py-2 text-left">File</th>
                    <th className="px-3 py-2 text-center w-12">R</th>
                    <th className="px-3 py-2 text-center w-12">W</th>
                    <th className="px-3 py-2 text-center w-12">E</th>
                    <th className="px-3 py-2 text-center w-12">D</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.path} className="border-b border-gray-700/50">
                      <td className="px-3 py-1.5 text-gray-300 truncate max-w-[200px]">{f.name}</td>
                      {(['read', 'write', 'edit', 'delete'] as const).map((key) => (
                        <td key={key} className="text-center">
                          <input
                            type="checkbox"
                            checked={permissions[f.path]?.[key] ?? (key === 'read')}
                            onChange={() => togglePerm(f.path, key)}
                            className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2 mb-2">
            <button
              onClick={handleSave}
              disabled={!files.length || saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Permissions'}
            </button>
            <button
              onClick={handleSkip}
              disabled={!files.length}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-white transition-colors disabled:opacity-50"
            >
              Skip (read-only)
            </button>
          </div>
          {setupMsg && <p className={`text-xs ${setupMsgColor}`}>{setupMsg}</p>}
        </div>
      )}

      {/* Chat area — shown after setup or when viewing existing session */}
      {(showChat || hasSession) && (
        <>
          {/* Header */}
          <div className="px-6 py-3 border-b border-gray-800 flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-gray-500">{connected ? 'Connected' : 'Disconnected'}</span>
            {hasSession && (
              <>
                <span className="text-gray-700">·</span>
                <h2 className="text-sm font-medium text-white">
                  Session {session.sessionId!.slice(0, 8)}
                </h2>
                <StatusBadge status={session.status} />
              </>
            )}
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
                      <MarkdownRenderer content={msg.content} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Live streaming bubble */}
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

            {session.thinkingText && (
              <ThinkingBlock text={session.thinkingText} />
            )}

            {session.error && (
              <div className="p-3 bg-red-900/30 border border-red-800 rounded text-red-300 text-sm">
                {session.error}
              </div>
            )}
          </div>

          {/* Start button — shown when setup is done but session hasn't started */}
          {showChat && !hasSession && (
            <div className="p-6 flex justify-center">
              <button
                onClick={handleStart}
                disabled={isStreaming}
                className="px-8 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-lg text-white transition-colors disabled:opacity-50"
              >
                {session.status === 'creating' ? 'Analyzing project...' : 'Start'}
              </button>
            </div>
          )}

          {/* Input — shown when session is done */}
          {hasSession && session.status === 'done' && (
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
