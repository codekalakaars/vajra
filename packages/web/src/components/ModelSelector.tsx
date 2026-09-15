import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Cpu } from 'lucide-react'

const C = { bg: '#0a0a0a', raised: '#1a1a1a', overlay: '#222222', border: '#2a2a2a', text: '#e5e5e5', textMuted: '#737373', placeholder: '#525252' }

const MODELS = [
  { group: 'Auto', options: [{ value: 'openrouter/free', label: 'Auto-route free models' }] },
  { group: 'Strong', options: [
    { value: 'thinkingmachines/inkling:free', label: 'Inkling 975B (1M ctx)' },
    { value: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B' },
    { value: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B' },
  ]},
  { group: 'General', options: [
    { value: 'thinkingmachines/inkling-small:free', label: 'Inkling Small 276B' },
    { value: 'dots-studio/dots-3-note-preview:free', label: 'Dots3-Note 280B' },
    { value: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B' },
    { value: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B' },
    { value: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'Nemotron 3 Nano 30B' },
  ]},
  { group: 'Fast', options: [
    { value: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning' },
    { value: 'inclusionai/ling-3.0-flash-vl:free', label: 'Ling 3.0 Flash VL' },
  ]},
  { group: 'Coding', options: [
    { value: 'nex-agi/nex-n2.5-pro:free', label: 'Nex-N2.5-Pro' },
    { value: 'poolside/laguna-s-2.1:free', label: 'Laguna S 2.1' },
    { value: 'poolside/laguna-xs-2.1:free', label: 'Laguna XS 2.1' },
    { value: 'cohere/north-mini-code:free', label: 'North Mini Code' },
  ]},
]

function getLabel(value: string): string {
  for (const g of MODELS) {
    const opt = g.options.find(o => o.value === value)
    if (opt) return opt.label
  }
  return value
}

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
        <span className="max-w-[120px] truncate">{getLabel(model)}</span>
        <ChevronDown size={10} style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.15s' }} />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 w-56 max-h-72 overflow-y-auto scroll-hidden rounded-lg py-1 z-50"
          style={{ background: C.overlay, border: `1px solid ${C.border}` }}
        >
          {MODELS.map((group) => (
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
