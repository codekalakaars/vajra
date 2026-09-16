import { useState, useEffect, useRef } from 'react'
import { File, Folder, Play, Download, RefreshCw, Code, Eye, ChevronRight, ChevronDown } from 'lucide-react'
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
  const [activeTab, setActiveTab] = useState<'code' | 'preview'>('code')
  const editorRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    loadFiles()
  }, [projectDir])

  useEffect(() => {
    if (selectedFile) {
      loadFileContent(selectedFile)
    }
  }, [selectedFile])

  const loadFiles = async () => {
    try {
      const result = await client.call('project.scan', { projectDir })
      const entries = result as Array<{ name: string; path: string; isDir: boolean }>
      // Ensure paths are absolute
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
      setFileContent((result as { content: string }).content)
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
    try {
      const result = await client.call('video.render', { projectDir, quality: 'standard', format: 'mp4' })
      setRenderOutput((result as { output?: string }).output || 'Render complete')
    } catch (e) {
      setRenderOutput('Render failed: ' + String(e))
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

  return (
    <div className="flex h-full">
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
          </div>
          <div className="ml-auto flex gap-2">
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
              {rendering ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
              {rendering ? 'Rendering...' : 'Render'}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'code' ? (
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
          ) : (
            <div className="h-full flex flex-col">
              <div className="flex-1 p-4 overflow-auto" style={{ background: '#0a0a0a' }}>
                {renderOutput ? (
                  <pre className="text-sm whitespace-pre-wrap" style={{ color: '#a3a3a3' }}>{renderOutput}</pre>
                ) : (
                  <div className="h-full flex items-center justify-center" style={{ color: '#525252' }}>
                    Click Render to generate video
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
