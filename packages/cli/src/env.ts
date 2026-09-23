import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const DEFAULT_MODEL = 'openai/gpt-4o-mini'

export const MODEL_PRESETS: Array<{ id: string; hint: string }> = [
  { id: 'openai/gpt-4o-mini', hint: 'Fast, default' },
  { id: 'openai/gpt-4o', hint: 'Fast' },
  { id: 'anthropic/claude-3-haiku', hint: 'Fast' },
]

/** Resolve the default model from env (VAJRA_MODEL wins over DEFAULT_MODEL). */
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VAJRA_MODEL || env.DEFAULT_MODEL
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : DEFAULT_MODEL
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
