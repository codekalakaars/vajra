export interface ModelOption {
  value: string
  label: string
}

export interface ModelGroup {
  group: string
  options: ModelOption[]
}

export const SHARED_MODELS: ModelGroup[] = [
  { group: 'Zen Free', options: [
    { value: 'zen/space-bunny-free', label: 'Space Bunny' },
    { value: 'zen/mimo-v2.5-free', label: 'MiMo V2.5' },
    { value: 'zen/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash' },
    { value: 'zen/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra' },
    { value: 'zen/nemotron-3.5-lightning-free', label: 'Nemotron 3.5 Lightning' },
    { value: 'zen/nemotron-3-super-free', label: 'Nemotron 3 Super' },
    { value: 'zen/ling-3.0-flash-fin-free', label: 'Ling 3.0 Flash' },
  ]},
  { group: 'Zen Paid', options: [
    { value: 'zen/gpt-5.5', label: 'GPT 5.5' },
    { value: 'zen/gpt-5.4-mini', label: 'GPT 5.4 Mini' },
    { value: 'zen/gpt-5.4', label: 'GPT 5.4' },
    { value: 'zen/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'zen/kimi-k3', label: 'Kimi K3' },
    { value: 'zen/big-pickle', label: 'Big Pickle' },
    { value: 'zen/mimo-v2.5', label: 'MiMo V2.5 (Paid)' },
  ]},
  { group: 'Go', options: [
    { value: 'go/mimo-v2.5', label: 'MiMo V2.5' },
    { value: 'go/mimo-v2.5-pro', label: 'MiMo V2.5 Pro' },
    { value: 'go/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'go/kimi-k3', label: 'Kimi K3' },
    { value: 'go/minimax-m3', label: 'MiniMax M3' },
    { value: 'go/glm-5.3', label: 'GLM 5.3' },
  ]},
]

export function getModelLabel(value: string): string {
  for (const g of SHARED_MODELS) {
    const opt = g.options.find(o => o.value === value)
    if (opt) return opt.label
  }
  return value
}
