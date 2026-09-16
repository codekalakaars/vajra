import { useRouter } from './hooks/useRouter'
import { ChatView } from './views/ChatView'
import { ProjectDetailView } from './views/ProjectDetailView'
import { Sidebar } from './components/Sidebar'
import { NewProjectModal } from './components/NewProjectModal'
import { VideoCreator } from './components/VideoCreator'
import { useClient } from './hooks/useProject'
import { useState, useEffect, useCallback } from 'react'

export function App() {
  const route = useRouter()
  const client = useClient()
  const [connected, setConnected] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const [showVideoCreator, setShowVideoCreator] = useState(false)

  useEffect(() => {
    return client.onStateChange((state) => {
      setConnected(state === 'connected')
    })
  }, [client])

  const handleNewProject = useCallback(() => setShowNewProject(true), [])
  const handleCloseModal = useCallback(() => setShowNewProject(false), [])
  const handleOpenVideoCreator = useCallback(() => setShowVideoCreator(true), [])
  const handleCloseVideoCreator = useCallback(() => setShowVideoCreator(false), [])

  return (
    <div className="flex h-screen" style={{ background: '#0a0a0a', color: '#e5e5e5' }}>
      <Sidebar client={client} onNewProject={handleNewProject} onOpenVideoCreator={handleOpenVideoCreator} />
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {route.path === '/' && <ChatView connected={connected} />}
            {route.path === '/project/:id' && <ProjectDetailView projectId={route.params.id} connected={connected} />}
          </div>
        </div>
      </div>
      <NewProjectModal client={client} open={showNewProject} onClose={handleCloseModal} />
      <VideoCreator open={showVideoCreator} onClose={handleCloseVideoCreator} projectDir="" client={client} />
    </div>
  )
}
