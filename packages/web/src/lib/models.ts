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
  { group: 'Auto (Recommended)', options: [{ value: 'openrouter/free', label: 'Auto-route free models' }] },
  { group: 'Strong (1M context)', options: [
    { value: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B' },
    { value: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B' },
    { value: 'dots-studio/dots-3-note-preview:free', label: 'Dots3-Note 280B' },
    { value: 'minimax/minimax-m3:free', label: 'MiniMax M3' },
    { value: 'thinkingmachines/inkling:free', label: 'Inkling' },
  ]},
  { group: 'Fast', options: [
    { value: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning' },
    { value: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'Nemotron 3 Nano 30B' },
    { value: 'inclusionai/ling-3.0-flash-vl:free', label: 'Ling 3.0 Flash VL' },
    { value: 'inclusionai/ling-3.0-flash-fin:free', label: 'Ling 3.0 Flash' },
  ]},
  { group: 'Coding', options: [
    { value: 'nex-agi/nex-n2.5-pro:free', label: 'Nex-N2.5-Pro' },
    { value: 'poolside/laguna-s-2.1:free', label: 'Laguna S 2.1' },
    { value: 'poolside/laguna-xs-2.1:free', label: 'Laguna XS 2.1' },
    { value: 'cohere/north-mini-code:free', label: 'North Mini Code' },
  ]},
  { group: 'General', options: [
    { value: 'z-ai/glm-5.2:free', label: 'GLM 5.2' },
    { value: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B' },
    { value: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B' },
    { value: 'minimax/minimax-m2.7:free', label: 'MiniMax M2.7' },
  ]},
]

export function getModelLabel(value: string): string {
  for (const g of SHARED_MODELS) {
    const opt = g.options.find(o => o.value === value)
    if (opt) return opt.label
  }
  return value
}
