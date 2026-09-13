import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useSession } from '../hooks/useSession'
import { StatusBadge } from '../components/StatusBadge'
import { ThinkingBlock } from '../components/ThinkingBlock'
import { MarkdownRenderer } from '../components/MarkdownRenderer'
import { PlanView } from '../components/PlanView'
import { WorkerStatus } from '../components/WorkerStatus'
import { ConflictAlert } from '../components/ConflictAlert'
import type { ReactNode } from 'react'

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

interface FileEntry { name: string; path: string; isDir: boolean; isMasked: boolean }
interface TreeNode { entry: FileEntry; children: TreeNode[]; depth: number }

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = []; const map = new Map<string, TreeNode>()
  const sorted = [...files].sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.path.localeCompare(b.path))
  for (const entry of sorted) {
    const parts = entry.path.split('/'); const depth = parts.length - 1
    const node: TreeNode = { entry, children: [], depth }; map.set(entry.path, node)
    if (depth === 0) root.push(node)
    else { const p = map.get(parts.slice(0, -1).join('/')); if (p) p.children.push(node); else root.push(node) }
  }
  return root
}

function filterTree(nodes: TreeNode[], filter: string): TreeNode[] {
  if (!filter) return nodes
  const lower = filter.toLowerCase()
  return nodes.map(n => {
    if (n.entry.name.toLowerCase().includes(lower)) return n
    if (n.entry.isDir) { const f = filterTree(n.children, filter); if (f.length > 0) return { ...n, children: f } }
    return null
  }).filter((n): n is TreeNode => n !== null)
}

function countFiles(n: TreeNode[]): number { let c = 0; for (const x of n) { if (!x.entry.isDir && !x.entry.isMasked) c++; c += countFiles(x.children) } return c }
function countChecked(n: TreeNode[], p: Record<string, boolean>): number { let c = 0; for (const x of n) { if (!x.entry.isDir && !x.entry.isMasked && p[x.entry.path] !== false) c++; c += countChecked(x.children, p) } return c }
function toggleAll(n: TreeNode[], v: boolean, p: Record<string, boolean>): Record<string, boolean> { const r = { ...p }; for (const x of n) { if (!x.entry.isDir && !x.entry.isMasked) r[x.entry.path] = v; Object.assign(r, toggleAll(x.children, v, p)) } return r }
function getIcon(e: FileEntry): string { if (e.isDir) return '📁'; if (e.isMasked) return '🔒'; if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) return '📄'; if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) return '📜'; if (e.name.endsWith('.json')) return '📋'; if (e.name.endsWith('.md')) return '📝'; if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) return '⚙️'; if (e.name.endsWith('.toml')) return '⚙️'; if (e.name.endsWith('.css')) return '🎨'; if (e.name.endsWith('.html')) return '🌐'; return '📄' }

const C = { bg: '#0a0a0a', chrome: '#111111', raised: '#1a1a1a', overlay: '#222222', muted: '#141414', border: '#2a2a2a', text: '#e5e5e5', textMuted: '#737373', placeholder: '#525252', input: '#333333' }

export function ChatView({ connected }: { connected: boolean }) {
  const session = useSession()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [projectDir, setProjectDir] = useState('')
  const [model, setModel] = useState('openrouter/free')
  const [inputValue, setInputValue] = useState('')
  const lastKeyRef = useRef<{ key: string; time: number }>({ key: '', time: 0 })
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

  const permTree = useMemo(() => filterTree(buildTree(permFiles), permFilter), [permFiles, permFilter])
  const totalFiles = useMemo(() => countFiles(permTree), [permTree])
  const checkedFiles = useMemo(() => countChecked(permTree, permMap), [permTree, permMap])
  const allChecked = totalFiles > 0 && checkedFiles === totalFiles
  const noneChecked = checkedFiles === 0

  const loadPermissionsForProject = useCallback(async (dir: string) => {
    if (!dir.trim()) { setPermLoaded(false); setPermFiles([]); setPermMap({}); return }
    setPermLoading(true); setPermError(null)
    try {
      const { permissions, files } = await session.loadPermissions(dir.trim())
      const map: Record<string, boolean> = {}
      for (const f of files) { if (!f.isDir) map[f.path] = f.isMasked ? false : (permissions[f.path]?.read ?? true) }
      setPermFiles(files); setPermMap(map); setPermLoaded(true)
      setExpandedDirs(new Set(files.filter(f => f.isDir && !f.path.includes('/')).map(f => f.path)))
    } catch (e) { setPermError(String(e)); setPermLoaded(false) } finally { setPermLoading(false) }
  }, [session])

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

  const handleStart = async () => {
    if (!projectDir.trim()) return
    const files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> = {}
    for (const [path, read] of Object.entries(permMap)) files[path] = { read, write: false, edit: false, delete: false }
    try { await session.createSession({ projectDir: projectDir.trim(), permissions: files, model }) } catch {}
  }
  const handleSend = async () => { const t = inputValue.trim(); if (!t || !session.sessionId) return; setInputValue(''); await session.sendMessage(t) }
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }
  const toggleDir = (p: string) => setExpandedDirs(prev => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n })
  const togglePerm = (p: string) => setPermMap(prev => ({ ...prev, [p]: !prev[p] }))
  const toggleAllFiles = () => setPermMap(prev => toggleAll(permTree, !allChecked, prev))

  const renderNode = (node: TreeNode): ReactNode => {
    const { entry, children } = node; const isExpanded = expandedDirs.has(entry.path)
    if (entry.isDir) {
      return (
        <div key={entry.path}>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer select-none hover:bg-zinc-900" style={{ paddingLeft: `${node.depth * 16 + 8}px` }} onClick={() => toggleDir(entry.path)}>
            <span className="text-xs w-3 text-center" style={{ color: C.placeholder }}>{isExpanded ? '▾' : '▸'}</span>
            <span className="text-sm">{getIcon(entry)}</span>
            <span className="text-sm truncate flex-1" style={{ color: C.textMuted }}>{entry.name}</span>
          </div>
          {isExpanded && <div>{children.map(child => renderNode(child))}</div>}
        </div>
      )
    }
    const allowed = permMap[entry.path] !== false
    if (entry.isMasked) {
      return (
        <div key={entry.path} className="flex items-center gap-1.5 px-2 py-1 rounded" style={{ paddingLeft: `${node.depth * 16 + 24}px` }}>
          <span className="text-sm">{getIcon(entry)}</span>
          <span className="text-sm truncate flex-1" style={{ color: C.placeholder }}>{entry.name}</span>
          <span className="text-xs italic" style={{ color: C.placeholder }}>masked</span>
        </div>
      )
    }
    return (
      <div key={entry.path} className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-zinc-900" style={{ paddingLeft: `${node.depth * 16 + 24}px` }}>
        <span className="text-sm">{getIcon(entry)}</span>
        <span className="text-sm truncate flex-1" style={{ color: C.textMuted }}>{entry.name}</span>
        <label className="flex items-center gap-1 cursor-pointer select-none" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={allowed} onChange={() => togglePerm(entry.path)} className="w-3.5 h-3.5 cursor-pointer" style={{ accentColor: '#737373' }} />
          <span className="text-xs" style={{ color: C.placeholder }}>{allowed ? 'read' : 'denied'}</span>
        </label>
      </div>
    )
  }

  const inputStyle = { background: C.raised, border: `1px solid ${C.border}`, color: C.text, outline: 'none' }
  const inputFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { e.currentTarget.style.borderColor = '#525252' }
  const inputBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { e.currentTarget.style.borderColor = C.border }

  return (
    <div className="flex flex-col h-full">
      {!hasSession && (
        <div className="p-6 max-w-3xl mx-auto w-full overflow-y-auto flex-1">
          <h2 className="text-xl font-bold mb-6" style={{ color: C.text }}>New Session</h2>
          <label className="block text-sm font-medium mb-1" style={{ color: C.textMuted }}>Project path</label>
          <div className="flex gap-2 mb-4">
            <input type="text" value={projectDir} onChange={e => setProjectDir(e.target.value)}
              onBlur={e => { loadPermissionsForProject(projectDir); inputBlur(e) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); loadPermissionsForProject(projectDir) } }}
              placeholder="/path/to/project" className="flex-1 px-3 py-2 rounded text-sm" style={inputStyle} onFocus={inputFocus} />
            <button onClick={() => loadPermissionsForProject(projectDir)} disabled={!projectDir.trim() || permLoading}
              className="px-3 py-2 rounded text-sm transition-colors disabled:opacity-50" style={{ background: C.overlay, color: C.textMuted }}>
              {permLoading ? '...' : 'Load'}
            </button>
          </div>
          <label className="block text-sm font-medium mb-1" style={{ color: C.textMuted }}>Model</label>
          <select value={model} onChange={e => setModel(e.target.value)} className="w-full px-3 py-2 rounded text-sm mb-6" style={inputStyle} onFocus={inputFocus} onBlur={inputBlur}>
            {MODELS.map(g => <optgroup key={g.group} label={g.group}>{g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>)}
          </select>

          {permError && <div className="mb-4 p-3 rounded text-sm" style={{ background: C.muted, border: `1px solid ${C.border}`, color: C.placeholder }}>{permError}</div>}

          {showPermissions && (
            <div className="rounded-lg overflow-hidden mb-6" style={{ border: `1px solid ${C.border}` }}>
              <div className="px-4 py-3" style={{ background: C.raised, borderBottom: `1px solid ${C.border}` }}>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-medium" style={{ color: C.text }}>Permissions</h3>
                    <p className="text-xs mt-0.5" style={{ color: C.placeholder }}>{checkedFiles} of {totalFiles} files readable{noneChecked && ' — agent cannot read any files'}</p>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={allChecked} onChange={toggleAllFiles} className="w-3.5 h-3.5 cursor-pointer" style={{ accentColor: '#737373' }} />
                    <span className="text-xs" style={{ color: C.placeholder }}>{allChecked ? 'All on' : 'Select all'}</span>
                  </label>
                </div>
                <input type="text" value={permFilter} onChange={e => setPermFilter(e.target.value)} placeholder="Filter files..."
                  className="w-full px-3 py-1.5 rounded text-xs" style={{ ...inputStyle, background: C.bg }} onFocus={inputFocus} onBlur={inputBlur} />
              </div>
              <div className="max-h-80 overflow-y-auto p-2" style={{ background: C.bg }}>
                {permTree.length === 0 && <div className="text-sm text-center py-4" style={{ color: C.placeholder }}>No files found</div>}
                {permTree.map(node => renderNode(node))}
              </div>
            </div>
          )}

          <button onClick={handleStart} disabled={!projectDir.trim() || isStreaming || (permLoaded && noneChecked)}
            className="w-full px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50"
            style={{ background: C.overlay, color: C.text }}>
            {session.status === 'creating' ? 'Starting...' : 'Start'}
          </button>
        </div>
      )}

      {hasSession && (
        <>
          <div className="px-6 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${C.border}` }}>
            <div className="w-2 h-2 rounded-full" style={{ background: connected ? '#e5e5e5' : C.input }} />
            <span className="text-xs" style={{ color: C.placeholder }}>{connected ? 'Connected' : 'Disconnected'}</span>
            <span style={{ color: C.border }}>·</span>
            <h2 className="text-sm font-medium" style={{ color: C.text }}>Session {session.sessionId!.slice(0, 8)}</h2>
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
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
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
        </>
      )}
    </div>
  )
}
