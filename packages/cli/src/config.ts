import { resolve } from 'node:path'
import { DEFAULT_MODEL, normalizeModelId } from './env.js'
import { configPath, ensureVajraHome, readJsonFile, writeJsonFile } from './home.js'

/**
 * User defaults in `~/.vajra/config.json`. Precedence per key (harness-style):
 * exported env var > config.json > built-in default — env wins only for the
 * keys the user actually exported.
 */
export interface VajraConfig {
  model?: string
  projectDir?: string
}

/** Env-var names honored as one-shot overrides (and legacy aliases). */
export const DEFAULT_MODEL_KEY = 'VAJRA_MODEL'
export const DEFAULT_DIR_KEY = 'VAJRA_PROJECT_DIR'

export function readConfig(env: NodeJS.ProcessEnv = process.env): VajraConfig {
  const raw = readJsonFile<VajraConfig>(configPath(env))
  if (!raw) return {}
  const out: VajraConfig = {}
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim()
  if (typeof raw.projectDir === 'string' && raw.projectDir.trim()) {
    out.projectDir = resolve(raw.projectDir.trim())
  }
  return out
}

/** Merge values into config.json and return the file path written. */
export function writeConfig(
  values: { model?: string; projectDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  ensureVajraHome(env)
  const current = readConfig(env)
  const next: VajraConfig = { ...current }
  if (values.model !== undefined) next.model = normalizeModelId(values.model)
  if (values.projectDir !== undefined) next.projectDir = resolve(values.projectDir)
  writeJsonFile(configPath(env), next)
  return configPath(env)
}

/** Default model: env.VAJRA_MODEL > env.DEFAULT_MODEL > config.json > builtin. */
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VAJRA_MODEL || env.DEFAULT_MODEL
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return readConfig(env).model ?? DEFAULT_MODEL
}

/** Default project dir: env.VAJRA_PROJECT_DIR > config.json > cwd. */
export function resolveDefaultDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DEFAULT_DIR_KEY]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return readConfig(env).projectDir ?? process.cwd()
}

/** True when the value comes from config.json rather than a fallback. */
export function isPersistedDefault(
  key: typeof DEFAULT_MODEL_KEY | typeof DEFAULT_DIR_KEY,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const config = readConfig(env)
  if (key === DEFAULT_MODEL_KEY) return Boolean(config.model)
  if (key === DEFAULT_DIR_KEY) return Boolean(config.projectDir)
  return false
}

/**
 * Persist defaults so they survive a restart (config.json) and return its
 * path, so the UI can show where they went.
 */
export function saveDefaults(
  values: { model?: string; projectDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return writeConfig(values, env)
}

/** Where a resolved value came from, for `vajra config -l`. */
export type ConfigSource = 'env' | 'config' | 'default'

export function configSource(
  key: 'model' | 'projectDir',
  env: NodeJS.ProcessEnv = process.env,
): ConfigSource {
  const config = readConfig(env)
  if (key === 'model') {
    if ((env.VAJRA_MODEL || env.DEFAULT_MODEL)?.trim()) return 'env'
    if (config.model) return 'config'
    return 'default'
  }
  if (env[DEFAULT_DIR_KEY]?.trim()) return 'env'
  if (config.projectDir) return 'config'
  return 'default'
}
