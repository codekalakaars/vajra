import { authPath, ensureVajraHome, readJsonFile, writeJsonFile } from './home.js'

/**
 * API keys in `~/.vajra/auth.json` (0600, never inside a project). Shape
 * mirrors Claude Code's `.credentials.json` / OpenCode's `auth.json`:
 * a flat owner-only JSON keyed by credential name.
 */
export interface AuthStore {
  OPENCODE_API_KEY?: string
}

export function readAuth(env: NodeJS.ProcessEnv = process.env): AuthStore {
  const raw = readJsonFile<AuthStore>(authPath(env))
  if (!raw) return {}
  const out: AuthStore = {}
  if (typeof raw.OPENCODE_API_KEY === 'string' && raw.OPENCODE_API_KEY.trim()) {
    out.OPENCODE_API_KEY = raw.OPENCODE_API_KEY.trim()
  }
  return out
}

/** Store credentials (0600) and return the file path written. */
export function writeAuth(values: AuthStore, env: NodeJS.ProcessEnv = process.env): string {
  ensureVajraHome(env)
  const next: AuthStore = { ...readAuth(env) }
  for (const [key, value] of Object.entries(values)) {
    if (value && value.trim()) next[key as keyof AuthStore] = value.trim()
    else delete next[key as keyof AuthStore]
  }
  writeJsonFile(authPath(env), next)
  return authPath(env)
}

/** Remove stored credentials. Returns true when something was deleted. */
export function clearAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  const current = readAuth(env)
  if (Object.keys(current).length === 0) return false
  writeJsonFile(authPath(env), {})
  return true
}

/** The stored OpenCode key, or undefined. */
export function storedOpenCodeKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readAuth(env).OPENCODE_API_KEY
}
