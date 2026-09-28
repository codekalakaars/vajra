import { storedOpenCodeKey } from './auth.js'
import { listModels, loadModelCatalog, modelHint, refreshModelStatus } from './models/catalog.js'

export const DEFAULT_MODEL = 'zen/space-bunny-free'

export interface ModelPreset {
  id: string
  hint: string
}

/** OpenCode Zen free models — only listed when OPENCODE_API_KEY is set. */
export const ZEN_FREE_PRESETS: ModelPreset[] = [
  { id: 'zen/mimo-v2.6-flash-free', hint: 'Free (Zen)' },
  { id: 'zen/mimo-v2.5-free', hint: 'Free (Zen)' },
  { id: 'zen/deepseek-v4-flash-free', hint: 'Free (Zen)' },
  { id: 'zen/space-bunny-free', hint: 'Free (Zen)' },
  { id: 'zen/big-pickle', hint: 'Free stealth (Zen)' },
  { id: 'zen/nemotron-3-ultra-free', hint: 'Free (Zen)' },
  { id: 'zen/nemotron-3.5-lightning-free', hint: 'Free (Zen)' },
  { id: 'zen/ling-3.0-flash-fin-free', hint: 'Free (Zen)' },
  { id: 'zen/muse-spark-1.3-contributor-free', hint: 'Free (Zen)' },
  { id: 'zen/jev-1.13-free', hint: 'Free (Zen)' },
]

/**
 * Models the user can actually reach with the keys they have configured.
 * OPENCODE_API_KEY from the env or ~/.vajra/auth.json → Zen presets (zen/*, go/*).
 *
 * The live catalog wins when it has been fetched: it knows every model the
 * gateway serves, and a hardcoded list of ten free ones is a list that was
 * wrong the day it was written. The presets stay as the answer for a first run
 * with no cache, which is the one moment there is nothing better to show.
 */
export function listAvailableModels(env: NodeJS.ProcessEnv = process.env): ModelPreset[] {
  if (!env.OPENCODE_API_KEY?.trim() && !storedOpenCodeKey(env)) return []
  const live = listModels({ includeUnavailable: false })
  if (live.length > 0) return live.map(info => ({ id: info.id, hint: modelHint(info) }))
  return ZEN_FREE_PRESETS
}

/** Only the OpenCode Zen gateway is supported (zen/* and go/* models). */
export function isSupportedModel(model: string): boolean {
  return model.startsWith('zen/') || model.startsWith('go/')
}

/**
 * Pick the credential that matches the model's transport.
 * zen/* and go/* go to OpenCode; every other model id is unsupported.
 * Precedence: explicit --api-key > env OPENCODE_API_KEY > ~/.vajra/auth.json.
 */
export function resolveApiKeyForModel(
  model: string,
  explicitKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const trimmed = explicitKey?.trim()
  if (trimmed) return trimmed
  if (isSupportedModel(model)) {
    return env.OPENCODE_API_KEY || storedOpenCodeKey(env)
  }
  return undefined
}

/** Trim and validate a model id (no whitespace, no '=', zen/* or go/* only). */
export function normalizeModelId(model: string): string {
  const cleaned = model.trim()
  if (!cleaned) {
    throw new Error('Model id is required')
  }
  if (/[\s=]/.test(cleaned)) {
    throw new Error(`Invalid model id: '${model}'`)
  }
  if (!isSupportedModel(cleaned)) {
    throw new Error(`Unsupported model '${cleaned}': only zen/* and go/* are supported`)
  }
  return cleaned
}

/** Parse `KEY=VALUE` for `vajra config -s`. Returns null if malformed. */
export function parseSetPair(pair: string): { key: string; value: string } | null {
  const eqIdx = pair.indexOf('=')
  if (eqIdx <= 0) return null
  const key = pair.slice(0, eqIdx).trim()
  const value = pair.slice(eqIdx + 1)
  if (!key) return null
  return { key, value }
}
