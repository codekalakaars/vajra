import { useState } from 'react'

export function ThinkingBlock({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!text) return null
  return (
    <div>
      <details open={open} className="group">
        <summary onClick={(e) => { e.preventDefault(); setOpen(!open) }} className="cursor-pointer flex items-center gap-2 text-sm select-none" style={{ color: '#525252' }}>
          <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Thinking...
        </summary>
        <div className="mt-2 pl-6 text-sm whitespace-pre-wrap" style={{ color: '#525252', borderLeft: '2px solid #2a2a2a' }}>
          {text}
        </div>
      </details>
    </div>
  )
}
