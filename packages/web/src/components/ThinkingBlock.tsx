import { useState } from 'react'

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(true)

  if (!text) return null

  return (
    <div>
      <details open={open} className="group">
        <summary
          onClick={(e) => { e.preventDefault(); setOpen(!open) }}
          className="cursor-pointer flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 select-none"
        >
          <svg
            className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Thinking...
        </summary>
        <div className="mt-2 pl-6 text-sm text-gray-400 border-l-2 border-gray-700 whitespace-pre-wrap">
          {text}
        </div>
      </details>
    </div>
  )
}
