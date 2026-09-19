import { useState, useEffect, useRef } from 'react'
import { File, Folder, Play, Download, RefreshCw, Code, Eye, ChevronRight, ChevronDown, Loader2, Square, ExternalLink, Variable, Plus, Trash2, Keyboard, Search } from 'lucide-react'
import type { VajraClient } from '../client'

interface FileEntry {
  name: string
  path: string
  isDir: boolean
  children?: FileEntry[]
}

interface VideoProjectViewProps {
  projectDir: string
  client: VajraClient
  onClose: () => void
}

export function VideoProjectView({ projectDir, client, onClose }: VideoProjectViewProps) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([projectDir]))
  const [rendering, setRendering] = useState(false)
  const [renderOutput, setRenderOutput] = useState<string | null>(null)
  const [renderProgress, setRenderProgress] = useState<string>('')
  const [activeTab, setActiveTab] = useState<'code' | 'preview' | 'live' | 'variables'>('code')
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [previewRunning, setPreviewRunning] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [newVarKey, setNewVarKey] = useState('')
  const [newVarValue, setNewVarValue] = useState('')
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const commandInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const previewFrameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    loadFiles()
    checkPreviewStatus()
    loadVariables()
    return () => {
      // Cleanup: stop preview on unmount
      client.call('video.stopPreview', { projectDir }).catch(() => {})
    }
  }, [projectDir])

  useEffect(() => {
    if (selectedFile) {
      loadFileContent(selectedFile)
    }
  }, [selectedFile])

  useEffect(() => {
    if (activeTab === 'preview' && selectedFile?.endsWith('.html')) {
      setPreviewHtml(fileContent)
    }
  }, [activeTab, selectedFile, fileContent])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ⌘S or Ctrl+S: Save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        saveFile()
      }
      // ⌘R or Ctrl+R: Render
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault()
        handleRender()
      }
      // ⌘P or Ctrl+P: Toggle preview
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        setActiveTab(prev => prev === 'preview' ? 'code' : 'preview')
      }
      // ⌘L or Ctrl+L: Toggle live preview
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        if (previewRunning) {
          setActiveTab('live')
        } else {
          startPreview()
        }
      }
      // ⌘E or Ctrl+E: Toggle variables
      if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
        e.preventDefault()
        setActiveTab(prev => prev === 'variables' ? 'code' : 'variables')
      }
      // Escape: Close file
      if (e.key === 'Escape') {
        if (showCommandPalette) {
          setShowCommandPalette(false)
        } else {
          setSelectedFile(null)
          setActiveTab('code')
        }
      }
      // ⌘K or Ctrl+K: Command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowCommandPalette(prev => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedFile, fileContent, previewRunning, showCommandPalette])

  const loadVariables = async () => {
    try {
      const result = await client.call('video.getVariables', { projectDir })
      const res = result as { variables?: Record<string, string> }
      setVariables(res.variables || {})
    } catch (e) {
      console.error('Failed to load variables:', e)
    }
  }

  const addVariable = async () => {
    if (!newVarKey.trim()) return
    try {
      await client.call('video.setVariable', { projectDir, key: newVarKey, value: newVarValue })
      setVariables(prev => ({ ...prev, [newVarKey]: newVarValue }))
      setNewVarKey('')
      setNewVarValue('')
    } catch (e) {
      console.error('Failed to add variable:', e)
    }
  }

  const updateVariable = async (key: string, value: string) => {
    try {
      await client.call('video.setVariable', { projectDir, key, value })
      setVariables(prev => ({ ...prev, [key]: value }))
    } catch (e) {
      console.error('Failed to update variable:', e)
    }
  }

  const deleteVariable = async (key: string) => {
    try {
      await client.call('video.deleteVariable', { projectDir, key })
      setVariables(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    } catch (e) {
      console.error('Failed to delete variable:', e)
    }
  }

  const checkPreviewStatus = async () => {
    try {
      const result = await client.call('video.getPreviewStatus', { projectDir })
      const status = result as { running?: boolean; url?: string }
      setPreviewRunning(status.running || false)
      setPreviewUrl(status.url || null)
    } catch (e) {
      console.error('Failed to check preview status:', e)
    }
  }

  const startPreview = async () => {
    try {
      const result = await client.call('video.startPreview', { projectDir })
      const res = result as { success: boolean; url?: string; port?: string }
      if (res.success) {
        setPreviewRunning(true)
        setPreviewUrl(res.url || `http://localhost:${res.port || '3002'}`)
        setActiveTab('live')
      }
    } catch (e) {
      console.error('Failed to start preview:', e)
    }
  }

  const stopPreview = async () => {
    try {
      await client.call('video.stopPreview', { projectDir })
      setPreviewRunning(false)
      setPreviewUrl(null)
    } catch (e) {
      console.error('Failed to stop preview:', e)
    }
  }

  const loadFiles = async () => {
    try {
      const result = await client.call('project.scan', { projectDir })
      const entries = result as Array<{ name: string; path: string; isDir: boolean }>
      setFiles(entries.map(e => ({
        ...e,
        path: e.path.startsWith('/') ? e.path : `${projectDir}/${e.name}`,
      })))
    } catch (e) {
      console.error('Failed to load files:', e)
    }
  }

  const loadFileContent = async (filePath: string) => {
    try {
      const result = await client.call('video.readFile', { path: filePath })
      setFileContent((result as { content: string }).content || '')
    } catch (e) {
      console.error('Failed to load file:', e)
    }
  }

  const saveFile = async () => {
    if (!selectedFile) return
    try {
      await client.call('video.writeFile', { path: selectedFile, content: fileContent })
    } catch (e) {
      console.error('Failed to save file:', e)
    }
  }

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const handleRender = async () => {
    setRendering(true)
    setRenderOutput(null)
    setRenderProgress('Starting render...')
    try {
      const result = await client.call('video.render', { projectDir, quality: 'standard', format: 'mp4' })
      const output = (result as { output?: string; error?: string }).output || (result as { error?: string }).error || 'Render complete'
      setRenderOutput(output)
      setRenderProgress('')
    } catch (e) {
      setRenderOutput('Render failed: ' + String(e))
      setRenderProgress('')
    } finally {
      setRendering(false)
    }
  }

  const renderFileTree = (entries: FileEntry[], depth = 0) => {
    return entries.map(entry => {
      const isExpanded = expandedDirs.has(entry.path)
      const isSelected = selectedFile === entry.path

  return (
        <div key={entry.path}>
          <div
            className="flex items-center gap-1 py-1 px-2 cursor-pointer text-sm"
            style={{
              paddingLeft: `${depth * 16 + 8}px`,
              background: isSelected ? '#222' : 'transparent',
              color: isSelected ? '#e5e5e5' : '#a3a3a3',
            }}
            onClick={() => {
              if (entry.isDir) {
                toggleDir(entry.path)
              } else {
                setSelectedFile(entry.path)
                if (entry.name.endsWith('.html')) {
                  setActiveTab('code')
                }
              }
            }}
          >
            {entry.isDir ? (
              isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
            ) : (
              <File size={14} style={{ marginLeft: '18px' }} />
            )}
            <span className="truncate">{entry.name}</span>
          </div>
          {entry.isDir && isExpanded && entry.children && renderFileTree(entry.children, depth + 1)}
        </div>
      )
    })
  }

  const filteredCommands = files.filter(f => !f.isDir).map(f => ({
    id: `open-${f.path}`, label: `Open ${f.name}`, description: f.path, action: () => setSelectedFile(f.path),
  }))

  const handleCommandSelect = (cmd: typeof filteredCommands[0]) => {
    cmd.action()
    setShowCommandPalette(false)
    setCommandQuery('')
  }

  const handleCommandKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCommandIndex(i => Math.min(i + 1, filteredCommands.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCommandIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filteredCommands[commandIndex]) handleCommandSelect(filteredCommands[commandIndex]) }
    else if (e.key === 'Escape') { setShowCommandPalette(false); setCommandQuery('') }
  }

  return (
    <div className="flex h-full">
      {/* Command Palette */}
      {showCommandPalette && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="w-[500px] rounded-lg overflow-hidden" style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}>
            <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid #2a2a2a' }}>
              <Search size={16} style={{ color: '#737373' }} />
              <input
                ref={commandInputRef}
                type="text"
                value={commandQuery}
                onChange={e => { setCommandQuery(e.target.value); setCommandIndex(0) }}
                onKeyDown={handleCommandKeyDown}
                placeholder="Type a command..."
                className="flex-1 bg-transparent text-sm focus:outline-none"
                style={{ color: '#e5e5e5' }}
                autoFocus
              />
              <kbd className="px-1.5 py-0.5 text-xs rounded" style={{ background: '#222', color: '#737373' }}>esc</kbd>
            </div>
            <div className="max-h-[300px] overflow-y-auto">
              {filteredCommands.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm" style={{ color: '#525252' }}>No commands found</div>
              ) : (
                filteredCommands.map((cmd, i) => (
                  <div
                    key={cmd.id}
                    className="flex items-center gap-3 px-4 py-2 cursor-pointer"
                    style={{ background: i === commandIndex ? '#222' : 'transparent' }}
                    onClick={() => handleCommandSelect(cmd)}
                    onMouseEnter={() => setCommandIndex(i)}
                  >
                    <span style={{ color: '#737373' }}><File size={16} /></span>
                    <div className="flex-1">
                      <div className="text-sm" style={{ color: '#e5e5e5' }}>{cmd.label}</div>
                      <div className="text-xs" style={{ color: '#737373' }}>{cmd.description}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* File Explorer */}
      <div className="w-64 flex flex-col" style={{ borderRight: '1px solid #2a2a2a', background: '#111' }}>
        <div className="p-3 flex items-center justify-between" style={{ borderBottom: '1px solid #2a2a2a' }}>
          <span className="text-sm font-medium">Files</span>
          <button onClick={onClose} className="text-xs" style={{ color: '#737373' }}>Close</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {renderFileTree(files)}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="px-4 py-2 flex items-center gap-4" style={{ borderBottom: '1px solid #2a2a2a' }}>
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab('code')}
              className="px-3 py-1.5 text-sm rounded flex items-center gap-1"
              style={{
                background: activeTab === 'code' ? '#222' : 'transparent',
                color: activeTab === 'code' ? '#e5e5e5' : '#737373',
              }}
            >
              <Code size={14} /> Code
            </button>
            <button
              onClick={() => setActiveTab('preview')}
              className="px-3 py-1.5 text-sm rounded flex items-center gap-1"
              style={{
                background: activeTab === 'preview' ? '#222' : 'transparent',
                color: activeTab === 'preview' ? '#e5e5e5' : '#737373',
              }}
            >
              <Eye size={14} /> Preview
            </button>
            <button
              onClick={() => {
                if (previewRunning) {
                  setActiveTab('live')
                } else {
                  startPreview()
                }
              }}
              className="px-3 py-1.5 text-sm rounded flex items-center gap-1"
              style={{
                background: activeTab === 'live' ? '#222' : 'transparent',
                color: activeTab === 'live' ? '#e5e5e5' : '#737373',
              }}
            >
              {previewRunning ? <Square size={14} /> : <Play size={14} />}
              Live
            </button>
            <button
              onClick={() => setActiveTab('variables')}
              className="px-3 py-1.5 text-sm rounded flex items-center gap-1"
              style={{
                background: activeTab === 'variables' ? '#222' : 'transparent',
                color: activeTab === 'variables' ? '#e5e5e5' : '#737373',
              }}
            >
              <Variable size={14} /> Variables
            </button>
          </div>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setShowShortcuts(!showShortcuts)}
              className="px-2 py-1.5 text-sm rounded flex items-center gap-1"
              style={{ background: showShortcuts ? '#222' : 'transparent', color: '#737373' }}
              title="Keyboard shortcuts"
            >
              <Keyboard size={14} />
            </button>
            {previewRunning && (
              <button
                onClick={stopPreview}
                className="px-3 py-1.5 text-sm rounded flex items-center gap-1"
                style={{ background: '#5a2a2a', color: '#ff6b6b' }}
              >
                <Square size={14} /> Stop Preview
              </button>
            )}
            <button
              onClick={saveFile}
              disabled={!selectedFile}
              className="px-3 py-1.5 text-sm rounded"
              style={{ background: '#222', color: '#e5e5e5' }}
            >
              Save
            </button>
            <button
              onClick={handleRender}
              disabled={rendering}
              className="px-3 py-1.5 text-sm rounded flex items-center gap-1"
              style={{ background: '#2563eb', color: '#fff' }}
            >
              {rendering ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {rendering ? 'Rendering...' : 'Render'}
            </button>
          </div>
        </div>

        {/* Render Progress */}
        {renderProgress && (
          <div className="px-4 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid #2a2a2a', background: '#0d0d0d' }}>
            <Loader2 size={14} className="animate-spin" style={{ color: '#2563eb' }} />
            <span className="text-sm" style={{ color: '#737373' }}>{renderProgress}</span>
          </div>
        )}

        {/* Keyboard Shortcuts Help */}
        {showShortcuts && (
          <div className="px-4 py-3" style={{ borderBottom: '1px solid #2a2a2a', background: '#111' }}>
            <div className="flex items-center gap-2 mb-2">
              <Keyboard size={14} style={{ color: '#737373' }} />
              <span className="text-sm font-medium">Keyboard Shortcuts</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: '#a3a3a3' }}>
              <div><kbd className="px-1 py-0.5 rounded" style={{ background: '#222' }}>⌘S</kbd> Save file</div>
              <div><kbd className="px-1 py-0.5 rounded" style={{ background: '#222' }}>⌘R</kbd> Render video</div>
              <div><kbd className="px-1 py-0.5 rounded" style={{ background: '#222' }}>⌘P</kbd> Toggle preview</div>
              <div><kbd className="px-1 py-0.5 rounded" style={{ background: '#222' }}>⌘L</kbd> Toggle live</div>
              <div><kbd className="px-1 py-0.5 rounded" style={{ background: '#222' }}>⌘E</kbd> Toggle variables</div>
              <div><kbd className="px-1 py-0.5 rounded" style={{ background: '#222' }}>Esc</kbd> Close file</div>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'code' && (
            <div className="h-full flex flex-col">
              {selectedFile ? (
                <>
                  <div className="px-4 py-2 text-xs" style={{ borderBottom: '1px solid #2a2a2a', color: '#737373' }}>
                    {selectedFile}
                  </div>
                  <textarea
                    ref={editorRef}
                    value={fileContent}
                    onChange={e => setFileContent(e.target.value)}
                    className="flex-1 p-4 text-sm font-mono resize-none focus:outline-none"
                    style={{ background: '#0a0a0a', color: '#e5e5e5' }}
                    spellCheck={false}
                  />
                </>
              ) : (
                <div className="h-full flex items-center justify-center" style={{ color: '#525252' }}>
                  Select a file to edit
                </div>
              )}
            </div>
          )}

          {activeTab === 'preview' && (
            <div className="h-full flex flex-col">
              {selectedFile?.endsWith('.html') ? (
                <iframe
                  ref={previewFrameRef}
                  srcDoc={previewHtml || fileContent}
                  className="flex-1 border-0"
                  style={{ background: '#000' }}
                  title="Preview"
                />
              ) : (
                <div className="h-full flex items-center justify-center" style={{ color: '#525252' }}>
                  {renderOutput ? (
                    <pre className="text-sm whitespace-pre-wrap p-4" style={{ color: '#a3a3a3' }}>{renderOutput}</pre>
                  ) : (
                    'Select an HTML file to preview'
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'live' && (
            <div className="h-full flex flex-col">
              {previewRunning && previewUrl ? (
                <>
                  <div className="px-4 py-2 flex items-center gap-2 text-xs" style={{ borderBottom: '1px solid #2a2a2a', color: '#737373' }}>
                    <span>Live Preview</span>
                    <span style={{ color: '#525252' }}>|</span>
                    <span>{previewUrl}</span>
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto flex items-center gap-1 hover:opacity-80"
                      style={{ color: '#2563eb' }}
                    >
                      <ExternalLink size={12} /> Open in browser
                    </a>
                  </div>
                  <iframe
                    src={previewUrl}
                    className="flex-1 border-0"
                    style={{ background: '#000' }}
                    title="Live Preview"
                  />
                </>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-4" style={{ color: '#525252' }}>
                  <p>Live preview not running</p>
                  <button
                    onClick={startPreview}
                    className="px-4 py-2 rounded text-sm flex items-center gap-2"
                    style={{ background: '#2563eb', color: '#fff' }}
                  >
                    <Play size={14} /> Start Preview Server
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'variables' && (
            <div className="h-full flex flex-col p-4 overflow-auto">
              <div className="mb-4">
                <h3 className="text-sm font-medium mb-2">Composition Variables</h3>
                <p className="text-xs" style={{ color: '#737373' }}>
                  Define variables that can be used in your HyperFrames composition.
                </p>
              </div>

              {/* Add new variable */}
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={newVarKey}
                  onChange={e => setNewVarKey(e.target.value)}
                  placeholder="Variable name"
                  className="flex-1 px-3 py-2 rounded text-sm"
                  style={{ background: '#222', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
                />
                <input
                  type="text"
                  value={newVarValue}
                  onChange={e => setNewVarValue(e.target.value)}
                  placeholder="Value"
                  className="flex-1 px-3 py-2 rounded text-sm"
                  style={{ background: '#222', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
                />
                <button
                  onClick={addVariable}
                  disabled={!newVarKey.trim()}
                  className="px-3 py-2 rounded text-sm flex items-center gap-1"
                  style={{ background: '#2563eb', color: '#fff' }}
                >
                  <Plus size={14} /> Add
                </button>
              </div>

              {/* Variable list */}
              <div className="space-y-2">
                {Object.entries(variables).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2 p-2 rounded" style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}>
                    <span className="text-sm font-mono" style={{ color: '#a3a3a3', minWidth: '120px' }}>{key}</span>
                    <input
                      type="text"
                      value={value}
                      onChange={e => updateVariable(key, e.target.value)}
                      className="flex-1 px-2 py-1 rounded text-sm"
                      style={{ background: '#222', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
                    />
                    <button
                      onClick={() => deleteVariable(key)}
                      className="p-1 rounded hover:opacity-80"
                      style={{ color: '#ff6b6b' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {Object.keys(variables).length === 0 && (
                  <div className="text-center py-8" style={{ color: '#525252' }}>
                    No variables defined
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
