import { useState } from 'react'
import type { VajraClient } from '../client'

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

const EXAMPLES: Template[] = [
  { name: 'blank', type: 'example', description: 'Empty canvas' },
  { name: 'warm-grain', type: 'example', description: 'Warm film grain aesthetic' },
  { name: 'play-mode', type: 'example', description: 'Playful interactive style' },
  { name: 'swiss-grid', type: 'example', description: 'Swiss design grid layout' },
  { name: 'vignelli', type: 'example', description: 'Vignelli modernist design' },
  { name: 'kinetic-type', type: 'example', description: 'Kinetic typography' },
  { name: 'product-promo', type: 'example', description: 'Product promotion' },
]

const BLOCKS: Template[] = [
  { name: 'apple-money-count', type: 'block', description: 'Animated counter' },
  { name: 'data-chart', type: 'block', description: 'Data visualization' },
  { name: 'code-highlight', type: 'block', description: 'Code syntax highlighting' },
  { name: 'lower-third-bild', type: 'block', description: 'Lower third overlay' },
  { name: 'news-ticker', type: 'block', description: 'News ticker animation' },
  { name: 'spotify-card', type: 'block', description: 'Spotify-style card' },
  { name: 'yt-lower-third', type: 'block', description: 'YouTube lower third' },
]

export function VideoCreator({ open, onClose, projectDir, client }: VideoCreatorProps) {
  const [tab, setTab] = useState<'templates' | 'blocks'>('templates')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const handleInitFromTemplate = async (templateName: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await client.call('video.init', { projectDir: `/tmp/video-${templateName}`, template: templateName })
      if ((result as { success: boolean }).success) {
        onClose()
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
            Templates
          </button>
          <button
            onClick={() => setTab('blocks')}
            className="flex-1 py-3 text-sm font-medium"
            style={{
              color: tab === 'blocks' ? '#e5e5e5' : '#737373',
              borderBottom: tab === 'blocks' ? '2px solid #e5e5e5' : '2px solid transparent',
            }}
          >
            Blocks
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto" style={{ maxHeight: 'calc(80vh - 140px)' }}>
          {error && (
            <div className="mb-4 p-3 rounded text-sm" style={{ background: '#2a1a1a', border: '1px solid #5a2a2a', color: '#ff6b6b' }}>
              {error}
            </div>
          )}

          {tab === 'templates' && (
            <div className="space-y-2">
              {EXAMPLES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => handleInitFromTemplate(t.name)}
                  disabled={loading}
                  className="w-full p-3 rounded text-left flex items-center justify-between"
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
              {BLOCKS.map((t) => (
                <button
                  key={t.name}
                  onClick={() => handleAddBlock(t.name)}
                  disabled={loading}
                  className="w-full p-3 rounded text-left flex items-center justify-between"
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
