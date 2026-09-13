import { useHashRouter } from './hooks/useHashRouter'
import { ChatView } from './views/ChatView'
import { SessionDetailView } from './views/SessionDetailView'
import { Sidebar } from './components/Sidebar'
import { NewSessionModal } from './components/NewSessionModal'
import { useClient } from './hooks/useSession'
import { useState, useEffect, useCallback } from 'react'

export function App() {
  const route = useHashRouter()
  const client = useClient()
  const [connected, setConnected] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)

  useEffect(() => {
    return client.onStateChange((state) => {
      setConnected(state === 'connected')
    })
  }, [client])

  const handleNewSession = useCallback(() => setShowNewSession(true), [])
  const handleCloseModal = useCallback(() => setShowNewSession(false), [])

  return (
    <div className="flex h-screen" style={{ background: '#0a0a0a', color: '#e5e5e5' }}>
      <Sidebar client={client} onNewSession={handleNewSession} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {route.path === '/' && <ChatView connected={connected} />}
          {route.path === '/session/:id' && <SessionDetailView sessionId={route.params.id} connected={connected} />}
        </div>
      </div>
      <NewSessionModal client={client} open={showNewSession} onClose={handleCloseModal} />
    </div>
  )
}
