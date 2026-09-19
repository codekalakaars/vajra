import { useState, useEffect, useRef, type ReactNode } from 'react'
import { Search, File, Code, Eye, Play, Square, Variable, Save, Keyboard } from 'lucide-react'

interface Command {
  id: string
  label: string
  description: string
  icon: ReactNode
  shortcut?: string
  action: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: Command[]
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const filtered = commands.filter(cmd =>
    cmd.label.toLowerCase().includes(query.toLowerCase()) ||
    cmd.description.toLowerCase().includes(query.toLowerCase())
  )

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].action()
        onClose()
      }
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="w-[500px] rounded-lg overflow-hidden" style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid #2a2a2a' }}>
          <Search size={16} style={{ color: '#737373' }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-sm focus:outline-none"
            style={{ color: '#e5e5e5' }}
          />
          <kbd className="px-1.5 py-0.5 text-xs rounded" style={{ background: '#222', color: '#737373' }}>esc</kbd>
        </div>

        {/* Command list */}
        <div className="max-h-[300px] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm" style={{ color: '#525252' }}>
              No commands found
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                className="flex items-center gap-3 px-4 py-2 cursor-pointer"
                style={{
                  background: i === selectedIndex ? '#222' : 'transparent',
                }}
                onClick={() => {
                  cmd.action()
                  onClose()
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span style={{ color: '#737373' }}>{cmd.icon}</span>
                <div className="flex-1">
                  <div className="text-sm" style={{ color: '#e5e5e5' }}>{cmd.label}</div>
                  <div className="text-xs" style={{ color: '#737373' }}>{cmd.description}</div>
                </div>
                {cmd.shortcut && (
                  <kbd className="px-1.5 py-0.5 text-xs rounded" style={{ background: '#222', color: '#a3a3a3' }}>
                    {cmd.shortcut}
                  </kbd>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
