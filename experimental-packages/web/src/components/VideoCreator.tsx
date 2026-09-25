import { useState, useEffect } from 'react'
import type { VajraClient } from '../client'
import { navigate } from '../hooks/useRouter'
import { Loader2, Search } from 'lucide-react'

interface Template {
  name: string
  type: 'example' | 'block' | 'component'
  description?: string
}

interface VideoCreatorProps {
  open: boolean
  onClose: () => void
  projectDir: string
  client: VajraClient
}

export function VideoCreator({ open, onClose, projectDir, client }: VideoCreatorProps) {
  const [tab, setTab] = useState<'templates' | 'blocks'>('templates')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [blocks, setBlocks] = useState<Template[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [fetchingRegistry, setFetchingRegistry] = useState(false)

  useEffect(() => {
    if (open) {
      fetchRegistryItems()
    }
  }, [open])

  const fetchRegistryItems = async () => {
    setFetchingRegistry(true)
    try {
      const [examplesResult, blocksResult] = await Promise.all([
        client.call('video.list', { type: 'example' }),
        client.call('video.list', { type: 'block' }),
      ])
      
      const examples = (examplesResult as { items?: Array<{ name: string; type: string }> }).items || []
      const blocksList = (blocksResult as { items?: Array<{ name: string; type: string }> }).items || []
      
      setTemplates(examples.map(e => ({
        name: e.name,
        type: 'example' as const,
        description: getDescription(e.name),
      })))
      
      setBlocks(blocksList.map(b => ({
        name: b.name,
        type: 'block' as const,
        description: getDescription(b.name),
      })))
    } catch (e) {
      console.error('Failed to fetch registry:', e)
      // Fallback to hardcoded list
      setTemplates([
        { name: 'blank', type: 'example', description: 'Empty canvas' },
        { name: 'warm-grain', type: 'example', description: 'Warm film grain aesthetic' },
        { name: 'play-mode', type: 'example', description: 'Playful interactive style' },
        { name: 'swiss-grid', type: 'example', description: 'Swiss design grid layout' },
        { name: 'vignelli', type: 'example', description: 'Vignelli modernist design' },
        { name: 'kinetic-type', type: 'example', description: 'Kinetic typography' },
        { name: 'product-promo', type: 'example', description: 'Product promotion' },
      ])
      setBlocks([
        { name: 'apple-money-count', type: 'block', description: 'Animated counter' },
        { name: 'data-chart', type: 'block', description: 'Data visualization' },
        { name: 'code-highlight', type: 'block', description: 'Code syntax highlighting' },
        { name: 'lower-third-bild', type: 'block', description: 'Lower third overlay' },
        { name: 'news-ticker', type: 'block', description: 'News ticker animation' },
        { name: 'spotify-card', type: 'block', description: 'Spotify-style card' },
        { name: 'yt-lower-third', type: 'block', description: 'YouTube lower third' },
      ])
    } finally {
      setFetchingRegistry(false)
    }
  }

  const getDescription = (name: string): string => {
    const descriptions: Record<string, string> = {
      'blank': 'Empty canvas',
      'warm-grain': 'Warm film grain aesthetic',
      'play-mode': 'Playful interactive style',
      'swiss-grid': 'Swiss design grid layout',
      'vignelli': 'Vignelli modernist design',
      'kinetic-type': 'Kinetic typography',
      'product-promo': 'Product promotion',
      'apple-money-count': 'Animated counter',
      'data-chart': 'Data visualization',
      'code-highlight': 'Code syntax highlighting',
      'lower-third-bild': 'Lower third overlay',
      'news-ticker': 'News ticker animation',
      'spotify-card': 'Spotify-style card',
      'yt-lower-third': 'YouTube lower third',
    }
    return descriptions[name] || name.replace(/-/g, ' ')
  }

  if (!open) return null

  const handleInitFromTemplate = async (templateName: string) => {
    setLoading(true)
    setError(null)
    const targetDir = `/tmp/video-${templateName}`
    try {
      const result = await client.call('video.init', { projectDir: targetDir, template: templateName })
      if ((result as { success: boolean }).success) {
        onClose()
        navigate(`/video/${encodeURIComponent(targetDir)}`)
      } else {
        setError((result as { error?: string }).error || 'Failed to initialize video')
      }
    } catch (e) {
      setError('Failed to connect to server')
    } finally {
      setLoading(false)
    }
  }

  const handleAddBlock = async (blockName: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await client.call('video.addBlock', { projectDir, block: blockName })
      if ((result as { success: boolean }).success) {
        onClose()
      } else {
        setError((result as { error?: string }).error || 'Failed to add block')
      }
    } catch (e) {
      setError('Failed to connect to server')
    } finally {
      setLoading(false)
    }
  }

  const filteredTemplates = templates.filter(t => 
    t.name.toLowerCase().includes(searchQuery.toLowerCase())
  )
  const filteredBlocks = blocks.filter(b => 
    b.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-[600px] max-h-[80vh] rounded-lg overflow-hidden" style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}>
        {/* Header */}
        <div className="flex items-center justify-between p-4" style={{ borderBottom: '1px solid #2a2a2a' }}>
          <h2 className="text-lg font-semibold">Create Video</h2>
          <button onClick={onClose} className="text-sm" style={{ color: '#737373' }}>
            ESC
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2" style={{ borderBottom: '1px solid #2a2a2a' }}>
          <div className="flex items-center gap-2 px-3 py-2 rounded" style={{ background: '#222', border: '1px solid #2a2a2a' }}>
            <Search size={14} style={{ color: '#737373' }} />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search templates and blocks..."
              className="flex-1 bg-transparent text-sm focus:outline-none"
              style={{ color: '#e5e5e5' }}
            />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex" style={{ borderBottom: '1px solid #2a2a2a' }}>
          <button
            onClick={() => setTab('templates')}
            className="flex-1 py-3 text-sm font-medium"
            style={{
              color: tab === 'templates' ? '#e5e5e5' : '#737373',
              borderBottom: tab === 'templates' ? '2px solid #e5e5e5' : '2px solid transparent',
            }}
          >
            Templates ({filteredTemplates.length})
          </button>
          <button
            onClick={() => projectDir ? setTab('blocks') : null}
            className="flex-1 py-3 text-sm font-medium"
            style={{
              color: tab === 'blocks' ? '#e5e5e5' : projectDir ? '#737373' : '#333',
              borderBottom: tab === 'blocks' ? '2px solid #e5e5e5' : '2px solid transparent',
              cursor: projectDir ? 'pointer' : 'not-allowed',
            }}
            title={projectDir ? 'Add blocks to current project' : 'Open a video project first to add blocks'}
          >
            Blocks ({filteredBlocks.length})
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto" style={{ maxHeight: 'calc(80vh - 180px)' }}>
          {error && (
            <div className="mb-4 p-3 rounded text-sm" style={{ background: '#2a1a1a', border: '1px solid #5a2a2a', color: '#ff6b6b' }}>
              {error}
            </div>
          )}

          {fetchingRegistry ? (
            <div className="flex items-center justify-center py-8" style={{ color: '#737373' }}>
              <Loader2 size={20} className="animate-spin mr-2" />
              Fetching registry...
            </div>
          ) : (
            <>
              {tab === 'templates' && (
                <div className="space-y-2">
                  {filteredTemplates.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => handleInitFromTemplate(t.name)}
                      disabled={loading}
                      className="w-full p-3 rounded text-left flex items-center justify-between hover:opacity-80 transition-opacity"
                      style={{
                        background: '#1a1a1a',
                        border: '1px solid #2a2a2a',
                      }}
                    >
                      <div>
                        <div className="font-medium">{t.name}</div>
                        <div className="text-xs" style={{ color: '#737373' }}>{t.description}</div>
                      </div>
                      <span className="text-xs px-2 py-1 rounded" style={{ background: '#2a2a2a', color: '#a3a3a3' }}>
                        example
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {tab === 'blocks' && (
                <div className="space-y-2">
                  {filteredBlocks.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => handleAddBlock(t.name)}
                      disabled={loading}
                      className="w-full p-3 rounded text-left flex items-center justify-between hover:opacity-80 transition-opacity"
                      style={{
                        background: '#1a1a1a',
                        border: '1px solid #2a2a2a',
                      }}
                    >
                      <div>
                        <div className="font-medium">{t.name}</div>
                        <div className="text-xs" style={{ color: '#737373' }}>{t.description}</div>
                      </div>
                      <span className="text-xs px-2 py-1 rounded" style={{ background: '#2a2a2a', color: '#a3a3a3' }}>
                        block
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4" style={{ borderTop: '1px solid #2a2a2a' }}>
          <p className="text-xs" style={{ color: '#525252' }}>
            Templates initialize a new project. Blocks add to the current project.
          </p>
        </div>
      </div>
    </div>
  )
}
