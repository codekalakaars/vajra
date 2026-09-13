import { useHashRouter } from './hooks/useHashRouter'
import { ChatView } from './views/ChatView'
import { ProjectDetailView } from './views/ProjectDetailView'
import { Sidebar } from './components/Sidebar'
import { NewProjectModal } from './components/NewProjectModal'
import { useClient } from './hooks/useProject'
import { useState, useEffect, useCallback } from 'react'

export function App() {
  const route = useHashRouter()
  const client = useClient()
  const [connected, setConnected] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)

  useEffect(() => {
    return client.onStateChange((state) => {
      setConnected(state === 'connected')
    })
  }, [client])

  const handleNewProject = useCallback(() => setShowNewProject(true), [])
  const handleCloseModal = useCallback(() => setShowNewProject(false), [])

  return (
    <div className="flex h-screen" style={{ background: '#0a0a0a', color: '#e5e5e5' }}>
      <Sidebar client={client} onNewProject={handleNewProject} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {route.path === '/' && <ChatView connected={connected} />}
          {route.path === '/project/:id' && <ProjectDetailView projectId={route.params.id} connected={connected} />}
        </div>
      </div>
      <NewProjectModal client={client} open={showNewProject} onClose={handleCloseModal} />
    </div>
  )
}
