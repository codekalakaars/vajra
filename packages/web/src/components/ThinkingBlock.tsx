import { useState, useCallback } from 'react'
import { ChevronRight } from 'lucide-react'

export function ThinkingBlock({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = useCallback(() => setOpen(o => !o), [])

  if (!text) return null
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
        className="cursor-pointer flex items-center gap-2 text-sm select-none"
        style={{ color: '#525252' }}
      >
        <ChevronRight size={16} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        Thinking...
      </div>
      {open && (
        <div className="mt-2 pl-6 text-sm whitespace-pre-wrap" style={{ color: '#525252', borderLeft: '2px solid #2a2a2a' }}>
          {text}
        </div>
      )}
    </div>
  )
}
