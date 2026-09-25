import { useState, useEffect, useCallback } from 'react'
import type { VajraClient } from '../client'
import { navigate } from '../hooks/useRouter'
import { PanelLeftClose, PanelLeft } from 'lucide-react'

interface Project { id: string; projectDir: string; task: string; model: string; status: string; createdAt: number }

export function Sidebar({ client, onNewProject, onOpenVideoCreator }: { client: VajraClient; onNewProject: () => void; onOpenVideoCreator?: () => void }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const toggleCollapsed = () => setCollapsed((c) => { localStorage.setItem('sidebar-collapsed', String(!c)); return !c })
  const [projects, setProjects] = useState<Project[]>([])
  const [currentPath, setCurrentPath] = useState(window.location.pathname)

  const refresh = useCallback(async () => {
    try { const list = await client.call('projects.list', {}) as Project[]; setProjects(list) } catch {}
  }, [client])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    const onPopState = () => { setCurrentPath(window.location.pathname); refresh() }
    window.addEventListener('popstate', onPopState)
    const unsubs = [client.on('projects.completed', () => refresh()), client.on('projects.failed', () => refresh()), client.on('projects.deleted', () => refresh())]
    return () => { clearInterval(interval); window.removeEventListener('popstate', onPopState); for (const u of unsubs) u() }
  }, [client, refresh])

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation()
    if (!confirm('Are you sure you want to delete this project?')) return
    try { await client.call('projects.delete', { projectId }); refresh() } catch {}
  }

  const dotColor = (status: string) => status === 'running' ? '#e5e5e5' : status === 'done' ? '#737373' : status === 'failed' ? '#525252' : '#333333'

  if (collapsed) {
    return (
      <div className="w-12 flex flex-col items-center pt-3" style={{ borderRight: '1px solid #2a2a2a', background: '#111111' }}>
        <img src="/Vajra_Logo_Dark.png" alt="Vajra" className="h-5 w-auto mb-2" />
        <button onClick={toggleCollapsed} className="p-2 transition-colors" style={{ color: '#525252' }} title="Expand sidebar">
          <PanelLeft size={20} />
        </button>
        <div className="mt-4 flex flex-col gap-2">
          {projects.map((s) => {
            const isActive = currentPath === `/project/${s.id}`
            return (
              <div key={s.id} onClick={() => navigate(`/project/${s.id}`)} title={`${s.projectDir.split('/').pop()} — ${s.task}`}
                className="w-8 h-8 rounded flex items-center justify-center cursor-pointer transition-colors"
                style={{ background: isActive ? '#222222' : '#1a1a1a' }}>
                <div className="w-2 h-2 rounded-full" style={{ background: dotColor(s.status) }} />
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="w-64 flex flex-col transition-all duration-200" style={{ borderRight: '1px solid #2a2a2a', background: '#111111' }}>
      <div className="p-3 flex items-center gap-2" style={{ borderBottom: '1px solid #2a2a2a' }}>
        <img src="/Vajra_Logo_Dark.png" alt="Vajra" className="h-5 w-auto" />
        <h1 className="text-lg font-bold flex-1" style={{ color: '#e5e5e5' }}>Vajra</h1>
        <button onClick={toggleCollapsed} className="p-1 transition-colors" style={{ color: '#525252' }} title="Collapse sidebar">
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="p-3 flex gap-2" style={{ borderBottom: '1px solid #2a2a2a' }}>
        <button onClick={onNewProject} className="flex-1 px-3 py-1.5 rounded text-sm transition-colors cursor-pointer" style={{ background: '#222222', color: '#e5e5e5' }}>
          New Project
        </button>
        {onOpenVideoCreator && (
          <button onClick={onOpenVideoCreator} className="px-3 py-1.5 rounded text-sm transition-colors cursor-pointer" style={{ background: '#222222', color: '#e5e5e5' }}>
            Video
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
          {projects.length === 0 ? (
          <div className="p-4 text-sm" style={{ color: '#525252' }}>No projects yet</div>
        ) : projects.map((s) => {
          const isActive = currentPath === `/project/${s.id}`
          return (
            <div key={s.id} onClick={() => navigate(`/project/${s.id}`)}
              className="group px-3 py-3 cursor-pointer transition-colors hover:bg-[#141414]"
              style={{ borderBottom: '1px solid #2a2a2a', background: isActive ? '#1a1a1a' : 'transparent' }}>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor(s.status) }} />
                <span className="text-sm truncate" style={{ color: '#e5e5e5' }}>{s.projectDir.split('/').pop() || s.projectDir}</span>
              </div>
              <div className="mt-1 text-xs truncate" style={{ color: '#737373' }}>{s.task}</div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-xs" style={{ color: '#525252' }}>{new Date(s.createdAt).toLocaleTimeString()}</span>
                <button onClick={e => handleDelete(e, s.id)} className="text-xs opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: '#525252' }}>Delete</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
