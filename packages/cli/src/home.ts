import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Per-user state home: `~/.vajra` (VAJRA_HOME overrides — tests and portable
 * installs point it at a temp dir). Holds config.json, auth.json, vajra.db
 * and the summary index. Resolved at call time so VAJRA_HOME can change
 * between calls (test isolation) without a restart.
 */
export function resolveVajraHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VAJRA_HOME
  return fromEnv && fromEnv.trim() ? resolve(fromEnv.trim()) : join(homedir(), '.vajra')
}

/** Create the home dir with owner-only permissions if missing. */
export function ensureVajraHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveVajraHome(env)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return home
}

/** User defaults (model, projectDir). Non-secret: plain 0600 JSON. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveVajraHome(env), 'config.json')
}

/** API keys. Never leave the home dir; always 0600. */
export function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveVajraHome(env), 'auth.json')
}

/** The single SQLite store: sessions + conversation messages. */
export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveVajraHome(env), 'vajra.db')
}

/** Content-fingerprint-keyed summary index (shared across checkouts). */
export function indexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveVajraHome(env), 'index')
}

export function ensureDirFor(filePath: string): void {
  mkdirSync(resolve(filePath, '..'), { recursive: true, mode: 0o700 })
}

/** Read a JSON object from the home dir, or null when absent/malformed. */
export function readJsonFile<T = Record<string, unknown>>(filePath: string): T | null {
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

/** Write a JSON object, creating the parent dir, owner-only (0600). */
export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDirFor(filePath)
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  // Existing files keep their old mode; force it back to owner-only.
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Filesystems without POSIX modes (e.g. NTFS mounts) simply ignore this.
  }
}
