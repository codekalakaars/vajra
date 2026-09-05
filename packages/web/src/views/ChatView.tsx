import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useSession } from '../hooks/useSession'
import { StatusBadge } from '../components/StatusBadge'
import { ThinkingBlock } from '../components/ThinkingBlock'
import { MarkdownRenderer } from '../components/MarkdownRenderer'
import { PlanView } from '../components/PlanView'
import { WorkerStatus } from '../components/WorkerStatus'
import { ConflictAlert } from '../components/ConflictAlert'

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

interface FileEntry {
  name: string
  path: string
  isDir: boolean
  isMasked: boolean
}

interface TreeNode {
  entry: FileEntry
  children: TreeNode[]
  depth: number
}

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = []
  const map = new Map<string, TreeNode>()

  // Sort: dirs first, then by path
  const sorted = [...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.path.localeCompare(b.path)
  })

  for (const entry of sorted) {
    const parts = entry.path.split('/')
    const depth = parts.length - 1
    const node: TreeNode = { entry, children: [], depth }
    map.set(entry.path, node)

    if (depth === 0) {
      root.push(node)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      const parent = map.get(parentPath)
      if (parent) {
        parent.children.push(node)
      } else {
        root.push(node)
      }
    }
  }

  return root
}

function filterTree(nodes: TreeNode[], filter: string): TreeNode[] {
  if (!filter) return nodes
  const lower = filter.toLowerCase()
  return nodes
    .map((node) => {
      if (node.entry.name.toLowerCase().includes(lower)) return node
      if (node.entry.isDir) {
        const filteredChildren = filterTree(node.children, filter)
        if (filteredChildren.length > 0) return { ...node, children: filteredChildren }
      }
      return null
    })
    .filter((n): n is TreeNode => n !== null)
}

function countFiles(nodes: TreeNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (!node.entry.isDir && !node.entry.isMasked) count++
    count += countFiles(node.children)
  }
  return count
}

function countChecked(nodes: TreeNode[], perms: Record<string, boolean>): number {
  let count = 0
  for (const node of nodes) {
    if (!node.entry.isDir && !node.entry.isMasked) {
      if (perms[node.entry.path] !== false) count++
    }
    count += countChecked(node.children, perms)
  }
  return count
}

function toggleAll(nodes: TreeNode[], value: boolean, perms: Record<string, boolean>): Record<string, boolean> {
  const next = { ...perms }
  for (const node of nodes) {
    if (!node.entry.isDir && !node.entry.isMasked) {
      next[node.entry.path] = value
    }
    Object.assign(next, toggleAll(node.children, value, perms))
  }
  return next
}

import type { ReactNode } from 'react'

function getIcon(entry: FileEntry): string {
  if (entry.isDir) return '📁'
  if (entry.isMasked) return '🔒'
  if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) return '📄'
  if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) return '📜'
  if (entry.name.endsWith('.json')) return '📋'
  if (entry.name.endsWith('.md')) return '📝'
  if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) return '⚙️'
  if (entry.name.endsWith('.toml')) return '⚙️'
  if (entry.name.endsWith('.css')) return '🎨'
  if (entry.name.endsWith('.html')) return '🌐'
  return '📄'
}

export function ChatView({ connected }: { connected: boolean }) {
  const session = useSession()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [projectDir, setProjectDir] = useState('')
  const [model, setModel] = useState('openrouter/free')
  const [inputValue, setInputValue] = useState('')
  const lastKeyRef = useRef<{ key: string; time: number }>({ key: '', time: 0 })

  // Permissions state
  const [permFilter, setPermFilter] = useState('')
  const [permFiles, setPermFiles] = useState<FileEntry[]>([])
  const [permMap, setPermMap] = useState<Record<string, boolean>>({})
  const [permLoading, setPermLoading] = useState(false)
  const [permError, setPermError] = useState<string | null>(null)
  const [permLoaded, setPermLoaded] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  const hasSession = session.sessionId !== null
  const isStreaming = session.status === 'streaming' || session.status === 'creating' || session.status === 'planning' || session.status === 'executing'
  const showPermissions = !hasSession && permLoaded

  const permTree = useMemo(() => {
    const tree = buildTree(permFiles)
    return filterTree(tree, permFilter)
  }, [permFiles, permFilter])

  const totalFiles = useMemo(() => countFiles(permTree), [permTree])
  const checkedFiles = useMemo(() => countChecked(permTree, permMap), [permTree, permMap])
  const allChecked = totalFiles > 0 && checkedFiles === totalFiles
  const noneChecked = checkedFiles === 0

  // Load permissions when project path is provided
  const loadPermissionsForProject = useCallback(async (dir: string) => {
    if (!dir.trim()) {
      setPermLoaded(false)
      setPermFiles([])
      setPermMap({})
      return
    }
    setPermLoading(true)
    setPermError(null)
    try {
      const { permissions, files } = await session.loadPermissions(dir.trim())
      // Default: .env files unchecked (masked), everything else checked
      const map: Record<string, boolean> = {}
      for (const f of files) {
        if (!f.isDir) {
          map[f.path] = f.isMasked ? false : (permissions[f.path]?.read ?? true)
        }
      }
      setPermFiles(files)
      setPermMap(map)
      setPermLoaded(true)
      // Expand top-level dirs by default
      const topDirs = new Set(files.filter(f => f.isDir && !f.path.includes('/')).map(f => f.path))
      setExpandedDirs(topDirs)
    } catch (e) {
      setPermError(String(e))
      setPermLoaded(false)
    } finally {
      setPermLoading(false)
    }
  }, [session])

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

    // Build permissions config from permMap
    const files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> = {}
    for (const [path, read] of Object.entries(permMap)) {
      files[path] = { read, write: false, edit: false, delete: false }
    }

    try {
      await session.createSession({
        projectDir: projectDir.trim(),
        permissions: files,
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

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const togglePerm = (path: string) => {
    setPermMap((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  const toggleAllFiles = () => {
    const newValue = !allChecked
    setPermMap((prev) => toggleAll(permTree, newValue, prev))
  }

  const renderNode = (node: TreeNode): ReactNode => {
    const { entry, children } = node
    const isExpanded = expandedDirs.has(entry.path)

    if (entry.isDir) {
      return (
        <div key={entry.path}>
          <div
            className="flex items-center gap-1.5 px-2 py-1 hover:bg-gray-800 rounded cursor-pointer select-none"
            style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
            onClick={() => toggleDir(entry.path)}
          >
            <span className="text-xs text-gray-500 w-3 text-center">{isExpanded ? '▾' : '▸'}</span>
            <span className="text-sm">{getIcon(entry)}</span>
            <span className="text-sm text-gray-300 truncate flex-1">{entry.name}</span>
          </div>
          {isExpanded && (
            <div>
              {children.map((child) => renderNode(child))}
            </div>
          )}
        </div>
      )
    }

    const allowed = permMap[entry.path] !== false

    if (entry.isMasked) {
      return (
        <div
          key={entry.path}
          className="flex items-center gap-1.5 px-2 py-1 rounded"
          style={{ paddingLeft: `${node.depth * 16 + 8 + 16}px` }}
        >
          <span className="text-sm">{getIcon(entry)}</span>
          <span className="text-sm text-gray-400 truncate flex-1">{entry.name}</span>
          <span className="text-xs text-yellow-500 italic">masked</span>
        </div>
      )
    }

    return (
      <div
        key={entry.path}
        className="flex items-center gap-1.5 px-2 py-1 hover:bg-gray-800 rounded"
        style={{ paddingLeft: `${node.depth * 16 + 8 + 16}px` }}
      >
        <span className="text-sm">{getIcon(entry)}</span>
        <span className="text-sm text-gray-300 truncate flex-1">{entry.name}</span>
        <label className="flex items-center gap-1 cursor-pointer select-none" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={allowed}
            onChange={() => togglePerm(entry.path)}
            className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
          />
          <span className={`text-xs ${allowed ? 'text-gray-400' : 'text-red-400'}`}>
            {allowed ? 'read' : 'denied'}
          </span>
        </label>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Setup — shown before session starts */}
      {!hasSession && (
        <div className="p-6 max-w-3xl mx-auto w-full overflow-y-auto flex-1">
          <h2 className="text-xl font-bold text-white mb-6">New Session</h2>

          <label className="block text-sm font-medium text-gray-300 mb-1">Project path</label>
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              onBlur={() => loadPermissionsForProject(projectDir)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  loadPermissionsForProject(projectDir)
                }
              }}
              placeholder="/path/to/project"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => loadPermissionsForProject(projectDir)}
              disabled={!projectDir.trim() || permLoading}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors disabled:opacity-50"
            >
              {permLoading ? '...' : 'Load'}
            </button>
          </div>

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

          {/* Permissions section */}
          {permError && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded text-red-300 text-sm">
              {permError}
            </div>
          )}

          {showPermissions && (
            <div className="border border-gray-700 rounded-lg overflow-hidden mb-6">
              <div className="bg-gray-800 px-4 py-3 border-b border-gray-700">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-medium text-white">Permissions</h3>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {checkedFiles} of {totalFiles} files readable
                      {noneChecked && <span className="text-red-400 ml-2">— agent cannot read any files</span>}
                    </p>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={toggleAllFiles}
                      className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                    />
                    <span className="text-xs text-gray-400">{allChecked ? 'All on' : 'Select all'}</span>
                  </label>
                </div>
                <input
                  type="text"
                  value={permFilter}
                  onChange={(e) => setPermFilter(e.target.value)}
                  placeholder="Filter files..."
                  className="w-full px-3 py-1.5 bg-gray-900 border border-gray-600 rounded text-white text-xs placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="max-h-80 overflow-y-auto p-2">
                {permTree.length === 0 && (
                  <div className="text-gray-500 text-sm text-center py-4">No files found</div>
                )}
                {permTree.map((node) => renderNode(node))}
              </div>
            </div>
          )}

          <button
            onClick={handleStart}
            disabled={!projectDir.trim() || isStreaming || (permLoaded && noneChecked)}
            className="w-full px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium transition-colors disabled:opacity-50"
          >
            {session.status === 'creating' ? 'Analyzing project...' : session.status === 'planning' ? 'Planning tasks...' : session.status === 'executing' ? 'Executing plan...' : 'Start'}
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
            {/* Multi-agent status views */}
            {(session.status === 'planning' || session.status === 'executing') && (
              <div className="space-y-3">
                {session.planTasks.length > 0 && (
                  <PlanView tasks={session.planTasks} />
                )}
                {session.agents.length > 0 && (
                  <WorkerStatus agents={session.agents} />
                )}
                {session.conflicts.length > 0 && (
                  <ConflictAlert conflicts={session.conflicts} />
                )}
              </div>
            )}

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
