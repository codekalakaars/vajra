import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { VajraClient } from '../client'
import { navigate } from '../hooks/useHashRouter'

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

const C = { bg: '#0a0a0a', chrome: '#111111', raised: '#1a1a1a', overlay: '#222222', muted: '#141414', border: '#2a2a2a', text: '#e5e5e5', textMuted: '#737373', placeholder: '#525252' }

interface BrowseEntry { name: string; path: string; isDir: boolean }

interface NewSessionModalProps {
  client: VajraClient
  open: boolean
  onClose: () => void
}

export function NewSessionModal({ client, open, onClose }: NewSessionModalProps) {
  const [projectDir, setProjectDir] = useState('')
  const [model, setModel] = useState('openrouter/free')
  const [permFilter, setPermFilter] = useState('')
  const [permFiles, setPermFiles] = useState<FileEntry[]>([])
  const [permMap, setPermMap] = useState<Record<string, boolean>>({})
  const [permLoading, setPermLoading] = useState(false)
  const [permError, setPermError] = useState<string | null>(null)
  const [permLoaded, setPermLoaded] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  // Browse/suggestions state
  const [suggestions, setSuggestions] = useState<BrowseEntry[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  const permTree = useMemo(() => filterTree(buildTree(permFiles), permFilter), [permFiles, permFilter])
  const totalFiles = useMemo(() => countFiles(permTree), [permTree])
  const checkedFiles = useMemo(() => countChecked(permTree, permMap), [permTree, permMap])
  const allChecked = totalFiles > 0 && checkedFiles === totalFiles
  const noneChecked = checkedFiles === 0

  const browseDirectories = useCallback(async (dir: string) => {
    setSuggestionsLoading(true)
    try {
      const entries = await client.call('project.browse', { dir }) as BrowseEntry[]
      setSuggestions(entries)
      setShowSuggestions(true)
      setSelectedSuggestionIdx(-1)
    } catch {
      setSuggestions([])
    } finally {
      setSuggestionsLoading(false)
    }
  }, [client])

  // Debounced browse on input change
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      if (projectDir.length > 0) {
        browseDirectories(projectDir)
      } else {
        // Show home directory contents when empty
        browseDirectories('~')
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [projectDir, open, browseDirectories])

  // Close suggestions on outside click
  useEffect(() => {
    if (!showSuggestions) return
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSuggestions])

  const handleSuggestionClick = (entry: BrowseEntry) => {
    setProjectDir(entry.path)
    setShowSuggestions(false)
    setSelectedSuggestionIdx(-1)
  }

  const handleSuggestionKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedSuggestionIdx(prev => Math.min(prev + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedSuggestionIdx(prev => Math.max(prev - 1, -1))
    } else if (e.key === 'Enter' && selectedSuggestionIdx >= 0) {
      e.preventDefault()
      handleSuggestionClick(suggestions[selectedSuggestionIdx])
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
    }
  }

  const loadPermissions = useCallback(async (dir: string) => {
    if (!dir.trim()) { setPermLoaded(false); setPermFiles([]); setPermMap({}); return }
    setPermLoading(true); setPermError(null)
    try {
      const perms = await client.call('project.loadPermissions', { projectDir: dir.trim() }) as { files: Record<string, { read: boolean }> }
      const files = await client.call('project.scan', { projectDir: dir.trim() }) as FileEntry[]
      const map: Record<string, boolean> = {}
      for (const f of files) { if (!f.isDir) map[f.path] = f.isMasked ? false : (perms.files?.[f.path]?.read ?? true) }
      setPermFiles(files); setPermMap(map); setPermLoaded(true)
      setExpandedDirs(new Set(files.filter(f => f.isDir && !f.path.includes('/')).map(f => f.path)))
    } catch (e) { setPermError(String(e)); setPermLoaded(false) } finally { setPermLoading(false) }
  }, [client])

  const handleCreate = async () => {
    if (!projectDir.trim()) return
    setCreating(true)
    const files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> = {}
    for (const [path, read] of Object.entries(permMap)) files[path] = { read, write: false, edit: false, delete: false }
    try {
      const result = await client.call('session.create', {
        projectDir: projectDir.trim(),
        task: '',
        model,
        permissions: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files },
      }) as { sessionId: string }
      onClose()
      navigate(`/session/${result.sessionId}`)
    } catch (e) {
      setPermError(String(e))
    } finally {
      setCreating(false)
    }
  }

  const toggleDir = (p: string) => setExpandedDirs(prev => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n })
  const togglePerm = (p: string) => setPermMap(prev => ({ ...prev, [p]: !prev[p] }))
  const toggleAllFiles = () => setPermMap(prev => toggleAll(permTree, !allChecked, prev))

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Close on backdrop click
  const handleBackdrop = (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose() }

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setProjectDir(''); setModel('openrouter/free'); setPermFilter(''); setPermFiles([]); setPermMap({})
      setPermLoading(false); setPermError(null); setPermLoaded(false); setExpandedDirs(new Set()); setCreating(false)
      setSuggestions([]); setShowSuggestions(false); setSelectedSuggestionIdx(-1)
    }
  }, [open])

  if (!open) return null

  const inputStyle = { background: C.raised, border: `1px solid ${C.border}`, color: C.text, outline: 'none' }
  const inputFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { e.currentTarget.style.borderColor = '#525252' }
  const inputBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { e.currentTarget.style.borderColor = C.border }

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={handleBackdrop}>
      <div ref={modalRef} className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg overflow-hidden" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: `1px solid ${C.border}` }}>
          <h2 className="text-lg font-semibold" style={{ color: C.text }}>New Session</h2>
          <button onClick={onClose} className="p-1 rounded transition-colors" style={{ color: C.placeholder }}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: C.textMuted }}>Project path</label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input ref={inputRef} type="text" value={projectDir} onChange={e => setProjectDir(e.target.value)}
                  onFocus={() => { setShowSuggestions(true); if (suggestions.length === 0) browseDirectories(projectDir || '~') }}
                  onKeyDown={handleSuggestionKeyDown}
                  placeholder="/path/to/project" className="w-full px-3 py-2 rounded text-sm" style={inputStyle} />
                {showSuggestions && suggestions.length > 0 && (
                  <div ref={suggestionsRef} className="absolute z-10 w-full mt-1 max-h-48 overflow-y-auto rounded shadow-lg" style={{ background: C.raised, border: `1px solid ${C.border}` }}>
                    {suggestions.map((entry, idx) => (
                      <div key={entry.path}
                        className="px-3 py-2 cursor-pointer flex items-center gap-2"
                        style={{
                          background: idx === selectedSuggestionIdx ? C.overlay : 'transparent',
                          color: C.text,
                        }}
                        onMouseEnter={() => setSelectedSuggestionIdx(idx)}
                        onClick={() => handleSuggestionClick(entry)}>
                        <span style={{ color: C.placeholder }}>{entry.isDir ? '📁' : '📄'}</span>
                        <span className="truncate text-sm">{entry.name}</span>
                        <span className="ml-auto text-xs truncate" style={{ color: C.placeholder }}>{entry.path}</span>
                      </div>
                    ))}
                  </div>
                )}
                {showSuggestions && suggestionsLoading && (
                  <div ref={suggestionsRef} className="absolute z-10 w-full mt-1 py-3 text-center text-sm" style={{ background: C.raised, border: `1px solid ${C.border}`, color: C.placeholder }}>
                    Loading...
                  </div>
                )}
              </div>
              <button onClick={() => loadPermissions(projectDir)} disabled={!projectDir.trim() || permLoading}
                className="px-3 py-2 rounded text-sm transition-colors disabled:opacity-50" style={{ background: C.overlay, color: C.textMuted }}>
                {permLoading ? '...' : 'Load'}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: C.textMuted }}>Model</label>
            <select value={model} onChange={e => setModel(e.target.value)} className="w-full px-3 py-2 rounded text-sm" style={inputStyle} onFocus={inputFocus} onBlur={inputBlur}>
              {MODELS.map(g => <optgroup key={g.group} label={g.group}>{g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>)}
            </select>
          </div>

          {permError && <div className="p-3 rounded text-sm" style={{ background: C.muted, border: `1px solid ${C.border}`, color: C.placeholder }}>{permError}</div>}

          {permLoaded && (
            <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
              <div className="px-4 py-3" style={{ background: C.raised, borderBottom: `1px solid ${C.border}` }}>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-medium" style={{ color: C.text }}>Permissions</h3>
                    <p className="text-xs mt-0.5" style={{ color: C.placeholder }}>
                      {checkedFiles} of {totalFiles} files readable
                      {noneChecked && <span> — agent cannot read any files</span>}
                    </p>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={allChecked} onChange={toggleAllFiles} className="w-3.5 h-3.5 cursor-pointer" style={{ accentColor: '#737373' }} />
                    <span className="text-xs" style={{ color: C.placeholder }}>{allChecked ? 'All on' : 'Select all'}</span>
                  </label>
                </div>
                <input type="text" value={permFilter} onChange={e => setPermFilter(e.target.value)} placeholder="Filter files..."
                  className="w-full px-3 py-1.5 rounded text-xs" style={{ ...inputStyle, background: C.bg }} onFocus={inputFocus} onBlur={inputBlur} />
              </div>
              <div className="max-h-60 overflow-y-auto p-2" style={{ background: C.bg }}>
                {permTree.length === 0 && <div className="text-sm text-center py-4" style={{ color: C.placeholder }}>No files found</div>}
                {permTree.map(node => renderNode(node))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 flex justify-end gap-3" style={{ borderTop: `1px solid ${C.border}` }}>
          <button onClick={onClose} className="px-4 py-2 rounded text-sm transition-colors" style={{ background: C.raised, color: C.textMuted }}>Cancel</button>
          <button onClick={handleCreate} disabled={!projectDir.trim() || creating || (permLoaded && noneChecked)}
            className="px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50" style={{ background: C.overlay, color: C.text }}>
            {creating ? 'Creating...' : 'Create Session'}
          </button>
        </div>
      </div>
    </div>
  )
}
