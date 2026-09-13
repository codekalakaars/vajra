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
      <div className="w-12 flex flex-col items-center pt-3" style={{ borderRight: '1px solid #2d2d2d', background: '#131313' }}>
        <button
          onClick={toggleCollapsed}
          className="p-2 transition-colors"
          style={{ color: '#898781' }}
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
                className="w-8 h-8 rounded flex items-center justify-center cursor-pointer transition-colors"
                style={{
                  background: isActive ? '#292927' : '#20201f',
                  color: isActive ? '#d97757' : '#898781',
                }}
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{
                    background: s.status === 'running' ? '#d97757'
                      : s.status === 'done' ? '#a5a39a'
                      : s.status === 'failed' ? '#ef7772'
                      : '#4d4d4c',
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="w-64 flex flex-col transition-all duration-200" style={{ borderRight: '1px solid #2d2d2d', background: '#131313' }}>
      <div className="p-3 flex items-center gap-2" style={{ borderBottom: '1px solid #2d2d2d' }}>
        <h1 className="text-lg font-bold flex-1" style={{ color: '#f7f7f2' }}>Vajra</h1>
        <button
          onClick={toggleCollapsed}
          className="p-1 transition-colors"
          style={{ color: '#898781' }}
          title="Collapse sidebar"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      <div className="p-3" style={{ borderBottom: '1px solid #2d2d2d' }}>
        <button
          onClick={() => navigate('/')}
          className="w-full px-3 py-1.5 rounded text-sm transition-colors"
          style={{ background: '#d97757', color: '#151515' }}
        >
          New Session
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          !collapsed && <div className="p-4 text-sm" style={{ color: '#898781' }}>No sessions yet</div>
        ) : (
          sessions.map((s) => {
            const isActive = currentPath === `#/session/${s.id}`
            return (
              <div
                key={s.id}
                onClick={() => navigate(`/session/${s.id}`)}
                title={collapsed ? `${s.projectDir.split('/').pop() || s.projectDir} — ${s.task}` : undefined}
                className="group px-3 py-3 cursor-pointer transition-colors"
                style={{
                  borderBottom: '1px solid #2d2d2d',
                  background: isActive ? '#20201f' : 'transparent',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = '#1b1b1a' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{
                      background: s.status === 'running' ? '#d97757'
                        : s.status === 'done' ? '#a5a39a'
                        : s.status === 'failed' ? '#ef7772'
                        : '#4d4d4c',
                    }}
                  />
                  {!collapsed && (
                    <span className="text-sm truncate" style={{ color: '#f7f7f2' }}>
                      {s.projectDir.split('/').pop() || s.projectDir}
                    </span>
                  )}
                </div>
                {!collapsed && (
                  <>
                    <div className="mt-1 text-xs truncate" style={{ color: '#a5a39a' }}>{s.task}</div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-xs" style={{ color: '#898781' }}>
                        {new Date(s.createdAt).toLocaleTimeString()}
                      </span>
                      <button
                        onClick={(e) => handleDelete(e, s.id)}
                        className="text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ color: '#ef7772' }}
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
