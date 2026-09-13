import { useHashRouter } from './hooks/useHashRouter'
import { ChatView } from './views/ChatView'
import { SessionDetailView } from './views/SessionDetailView'
import { Sidebar } from './components/Sidebar'
import { useClient } from './hooks/useSession'
import { useState, useEffect } from 'react'

export function App() {
  const route = useHashRouter()
  const client = useClient()
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    return client.onStateChange((state) => {
      setConnected(state === 'connected')
    })
  }, [client])

  return (
    <div className="flex h-screen" style={{ background: '#151515', color: '#f7f7f2' }}>
      <Sidebar client={client} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {route.path === '/' && <ChatView connected={connected} />}
          {route.path === '/session/:id' && <SessionDetailView sessionId={route.params.id} connected={connected} />}
        </div>
      </div>
    </div>
  )
}
