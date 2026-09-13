import { useState, useEffect, useCallback } from 'react'
import type { VajraClient } from '../client'
import { navigate } from '../hooks/useHashRouter'

interface Session {
  id: string
  projectDir: string
  task: string
  model: string
  status: string
  createdAt: number
}

const STATUS_COLORS: Record<string, string> = {
  starting: 'bg-zinc-600',
  running: 'bg-white',
  done: 'bg-zinc-500',
  failed: 'bg-zinc-700',
  stopped: 'bg-zinc-800',
}

export function Sidebar({ client }: { client: VajraClient }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const toggleCollapsed = () => setCollapsed((c) => { localStorage.setItem('sidebar-collapsed', String(!c)); return !c })
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentPath, setCurrentPath] = useState(window.location.hash)

  const refresh = useCallback(async () => {
    try {
      const list = await client.call('session.list', {}) as Session[]
      setSessions(list)
    } catch {
      // ignore
    }
  }, [client])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    window.addEventListener('hashchange', () => {
      setCurrentPath(window.location.hash)
      refresh()
    })

    const unsubs = [
      client.on('session.completed', () => refresh()),
      client.on('session.failed', () => refresh()),
      client.on('session.deleted', () => refresh()),
    ]

    return () => {
      clearInterval(interval)
      for (const u of unsubs) u()
    }
  }, [client, refresh])

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    try {
      await client.call('session.delete', { sessionId })
      refresh()
    } catch {
      // ignore
    }
  }

  if (collapsed) {
    return (
      <div className="w-12 border-r border-zinc-800 bg-black flex flex-col items-center pt-3">
        <button
          onClick={toggleCollapsed}
          className="p-2 text-zinc-600 hover:text-zinc-300 transition-colors"
          title="Expand sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="mt-4 flex flex-col gap-2">
          {sessions.map((s) => {
            const isActive = currentPath === `#/session/${s.id}`
            return (
              <div
                key={s.id}
                onClick={() => navigate(`/session/${s.id}`)}
                title={`${s.projectDir.split('/').pop() || s.projectDir} — ${s.task}`}
                className={`w-8 h-8 rounded flex items-center justify-center cursor-pointer transition-colors ${
                  isActive ? 'bg-white text-black' : 'bg-zinc-900 text-zinc-500 hover:bg-zinc-800'
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[s.status] || 'bg-zinc-700'}`} />
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="w-64 border-r border-zinc-800 bg-black flex flex-col transition-all duration-200">
      <div className="p-3 border-b border-zinc-800 flex items-center gap-2">
        <h1 className="text-lg font-bold text-white flex-1">Vajra</h1>
        <button
          onClick={toggleCollapsed}
          className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors"
          title="Collapse sidebar"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      <div className="p-3 border-b border-zinc-800">
        <button
          onClick={() => navigate('/')}
          className="w-full px-3 py-1.5 bg-white hover:bg-zinc-200 rounded text-sm text-black transition-colors"
        >
          New Session
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          !collapsed && <div className="p-4 text-sm text-zinc-600">No sessions yet</div>
        ) : (
          sessions.map((s) => {
            const isActive = currentPath === `#/session/${s.id}`
            return (
              <div
                key={s.id}
                onClick={() => navigate(`/session/${s.id}`)}
                title={collapsed ? `${s.projectDir.split('/').pop() || s.projectDir} — ${s.task}` : undefined}
                className={`group px-3 py-3 cursor-pointer border-b border-zinc-800 transition-colors ${
                  isActive ? 'bg-zinc-900' : 'hover:bg-zinc-900/50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[s.status] || 'bg-zinc-700'}`} />
                  {!collapsed && (
                    <span className="text-sm text-white truncate">
                      {s.projectDir.split('/').pop() || s.projectDir}
                    </span>
                  )}
                </div>
                {!collapsed && (
                  <>
                    <div className="mt-1 text-xs text-zinc-500 truncate">{s.task}</div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-xs text-zinc-600">
                        {new Date(s.createdAt).toLocaleTimeString()}
                      </span>
                      <button
                        onClick={(e) => handleDelete(e, s.id)}
                        className="text-xs text-zinc-600 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
