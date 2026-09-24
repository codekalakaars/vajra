import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const DEFAULT_MODEL = 'zen/space-bunny-free'

export interface ModelPreset {
  id: string
  hint: string
}

/** OpenRouter models — only listed when OPENROUTER_API_KEY is set. */
export const OPENROUTER_PRESETS: ModelPreset[] = [
  { id: 'openai/gpt-4o-mini', hint: 'Fast' },
  { id: 'openai/gpt-4o', hint: 'Fast' },
  { id: 'anthropic/claude-3-haiku', hint: 'Fast' },
]

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
 * - OPENCODE_API_KEY → Zen free presets (zen/*)
 * - OPENROUTER_API_KEY → OpenRouter presets (openai/*, anthropic/*)
 */
export function listAvailableModels(env: NodeJS.ProcessEnv = process.env): ModelPreset[] {
  const out: ModelPreset[] = []
  if (env.OPENCODE_API_KEY?.trim()) out.push(...ZEN_FREE_PRESETS)
  if (env.OPENROUTER_API_KEY?.trim()) out.push(...OPENROUTER_PRESETS)
  return out
}

/** Resolve the default model from env (VAJRA_MODEL wins over DEFAULT_MODEL). */
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VAJRA_MODEL || env.DEFAULT_MODEL
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : DEFAULT_MODEL
}

/**
 * Pick the credential that matches the model's transport.
 * zen/* and go/* go to OpenCode; everything else goes through OpenRouter.
 * An explicit --api-key always wins.
 */
export function resolveApiKeyForModel(
  model: string,
  explicitKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const trimmed = explicitKey?.trim()
  if (trimmed) return trimmed
  if (model.startsWith('zen/') || model.startsWith('go/')) {
    return env.OPENCODE_API_KEY || undefined
  }
  return env.OPENROUTER_API_KEY || undefined
}

/** Trim and validate a model id (OpenRouter ids contain no whitespace or '='). */
export function normalizeModelId(model: string): string {
  const cleaned = model.trim()
  if (!cleaned) {
    throw new Error('Model id is required')
  }
  if (/[\s=]/.test(cleaned)) {
    throw new Error(`Invalid model id: '${model}'`)
  }
  return cleaned
}

/** Repo root: three levels above the CLI entry (packages/cli/dist/index.js -> repo root). */
export function getRootDir(entryScript?: string): string {
  const entry = entryScript ?? process.argv[1]
  if (entry) {
    return resolve(dirname(entry), '..', '..', '..')
  }
  return process.cwd()
}

/**
 * Locate the .env file. Walks up from cwd first so a project-local .env
 * takes precedence over the install/repo-root .env (G2). Falls back to the
 * entry-anchored repo root path for writing when nothing exists yet.
 */
export function findEnvPath(): string {
  const candidates: string[] = []
  const push = (p: string) => {
    if (!candidates.includes(p)) candidates.push(p)
  }
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    push(resolve(dir, '.env'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (process.argv[1]) {
    push(resolve(getRootDir(), '.env'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? resolve(process.cwd(), '.env')
}

/** Parse a .env file into key/value pairs (ignores blanks and # comments). */
export function readEnvFile(envPath: string): Record<string, string> {
  const values: Record<string, string> = {}
  if (!existsSync(envPath)) return values
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) {
      values[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
    }
  }
  return values
}

/**
 * (Re)load KEY=VALUE pairs from the discovered .env into process.env.
 * Used by the TUI loop so `config -s` (child process writes the file)
 * is visible without restarting. Empty values are skipped.
 */
export function loadEnvIntoProcess(env: NodeJS.ProcessEnv = process.env): string {
  const envPath = findEnvPath()
  const values = readEnvFile(envPath)
  for (const [key, value] of Object.entries(values)) {
    if (value) env[key] = value
  }
  return envPath
}

/** Create or update a single KEY=VALUE line, preserving the rest of the file. */
export function writeEnvKey(envPath: string, key: string, value: string): void {
  if (!key || /[\s=#]/.test(key)) {
    throw new Error(`Invalid env key: '${key}'`)
  }
  if (value.includes('\n')) {
    throw new Error(`Invalid value for '${key}': must be a single line`)
  }
  const envExists = existsSync(envPath)
  let envContent = envExists ? readFileSync(envPath, 'utf-8') : ''
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escapedKey}=.*$`, 'm')
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${key}=${value}`)
  } else {
    if (envContent.length > 0 && !envContent.endsWith('\n')) {
      envContent += '\n'
    }
    envContent += `${key}=${value}\n`
  }
  writeFileSync(envPath, envContent)
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
