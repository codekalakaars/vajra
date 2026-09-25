import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Cpu } from 'lucide-react'
import { SHARED_MODELS, getModelLabel } from '../lib/models'

import { C } from '../lib/theme'

export function ModelSelector({ model, onSelect, disabled }: { model: string; onSelect: (model: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors"
        style={{
          background: C.raised,
          border: `1px solid ${open ? '#525252' : C.border}`,
          color: C.textMuted,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
        title="Select model"
      >
        <Cpu size={12} />
        <span className="max-w-[120px] truncate">{getModelLabel(model)}</span>
        <ChevronDown size={10} style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.15s' }} />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 w-56 max-h-72 overflow-y-auto scroll-hidden rounded-lg py-1 z-50"
          style={{ background: C.overlay, border: `1px solid ${C.border}` }}
        >
          {SHARED_MODELS.map((group) => (
            <div key={group.group}>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.placeholder }}>{group.group}</div>
              {group.options.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => { onSelect(opt.value); setOpen(false) }}
                  className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors"
                  style={{
                    color: model === opt.value ? C.text : C.textMuted,
                    background: model === opt.value ? C.raised : 'transparent',
                  }}
                  onMouseEnter={(e) => { if (model !== opt.value) e.currentTarget.style.background = C.raised }}
                  onMouseLeave={(e) => { if (model !== opt.value) e.currentTarget.style.background = 'transparent' }}
                >
                  <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: model === opt.value ? '#e5e5e5' : 'transparent' }} />
                  {opt.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
