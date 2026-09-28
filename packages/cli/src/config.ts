import { resolve } from 'node:path'
import { DEFAULT_MODEL, normalizeModelId } from './env.js'
import { configPath, ensureVajraHome, readJsonFile, writeJsonFile } from './home.js'

/**
 * The three roles that reason, named as the user names them.
 *
 * `manager` is `master` in the agent registry and `developer` is the role you
 * converse with. The user's words are the ones on screen: a setting called
 * `masterModel` is a setting nobody would guess.
 */
export type RoleName = 'developer' | 'manager' | 'worker'

/** In the order they are shown, which is the order work flows through them. */
export const ROLE_NAMES: readonly RoleName[] = ['developer', 'manager', 'worker']

/** One line each, for a row that has to say what the role is for. */
export const ROLE_PURPOSE: Record<RoleName, string> = {
  developer: 'plans your work',
  manager: 'inspects it',
  worker: 'does it',
}

/**
 * User defaults in `~/.vajra/config.json`. Precedence per key (harness-style):
 * exported env var > config.json > built-in default — env wins only for the
 * keys the user actually exported.
 */
export interface VajraConfig {
  /** The fallback: what every role runs on unless it has a model of its own. */
  model?: string
  projectDir?: string
  /** ADR-0010: each role's model is configured independently of the others. */
  developerModel?: string
  managerModel?: string
  workerModel?: string
}

/** Every key in config.json, for the loops that read or list them all. */
export type ConfigKey = keyof VajraConfig

/** Env-var names honored as one-shot overrides (and legacy aliases). */
export const DEFAULT_MODEL_KEY = 'VAJRA_MODEL'
export const DEFAULT_DIR_KEY = 'VAJRA_PROJECT_DIR'

/** The env var that overrides a role's model, e.g. `VAJRA_WORKER_MODEL`. */
export const roleModelEnvKey = (role: RoleName): string => `VAJRA_${role.toUpperCase()}_MODEL`

/** The config.json key that holds a role's model. */
export const roleModelKey = (role: RoleName): ConfigKey => `${role}Model` as ConfigKey

/**
 * Read config.json, keeping only the keys that are actually usable.
 *
 * A model id is normalized on the way in, so a hand-edited file cannot put a
 * string in the model slot that the request builder would later choke on — the
 * same reason `model` was always validated rather than trusted.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): VajraConfig {
  const raw = readJsonFile<VajraConfig>(configPath(env))
  if (!raw) return {}
  const out: VajraConfig = {}
  for (const key of ['model', 'developerModel', 'managerModel', 'workerModel'] as const) {
    const value = raw[key]
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      out[key] = normalizeModelId(value)
    } catch {
      // A key that cannot be a model id is treated as absent rather than
      // fatal: one bad line in a hand-edited file should not stop Vajra from
      // starting on the models that are fine.
    }
  }
  if (typeof raw.projectDir === 'string' && raw.projectDir.trim()) {
    out.projectDir = resolve(raw.projectDir.trim())
  }
  return out
}

/** Merge values into config.json and return the file path written. */
export function writeConfig(values: Partial<VajraConfig>, env: NodeJS.ProcessEnv = process.env): string {
  ensureVajraHome(env)
  const current = readConfig(env)
  const next: VajraConfig = { ...current }
  for (const key of ['model', 'developerModel', 'managerModel', 'workerModel'] as const) {
    const value = values[key]
    if (value !== undefined) next[key] = normalizeModelId(value)
  }
  if (values.projectDir !== undefined) next.projectDir = resolve(values.projectDir)
  writeJsonFile(configPath(env), next)
  return configPath(env)
}

/**
 * Remove keys from config.json, so a role can be put back on the default
 * without a screen that means "set it to empty" — which is not the same thing
 * and would leave an empty string in the file for `readConfig` to reject.
 */
export function clearConfig(keys: readonly ConfigKey[], env: NodeJS.ProcessEnv = process.env): string {
  ensureVajraHome(env)
  const next: VajraConfig = { ...readConfig(env) }
  for (const key of keys) delete next[key]
  writeJsonFile(configPath(env), next)
  return configPath(env)
}

/** Default model: env.VAJRA_MODEL > env.DEFAULT_MODEL > config.json > builtin. */
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VAJRA_MODEL || env.DEFAULT_MODEL
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return readConfig(env).model ?? DEFAULT_MODEL
}

/**
 * The model a role actually runs on: its own if it has one, else the default.
 *
 * The fallback is the point. Three roles with three models is the target shape,
 * but a user who has never opened `/config` must get the behaviour they had
 * before this key existed — one model, everywhere — rather than three copies of
 * the built-in default that they then have to keep in step by hand.
 */
export function resolveRoleModel(role: RoleName, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[roleModelEnvKey(role)]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return readConfig(env)[roleModelKey(role)] ?? resolveDefaultModel(env)
}

/** Every role's model, resolved, for a screen that shows all of them at once. */
export function resolveRoleModels(env: NodeJS.ProcessEnv = process.env): Record<RoleName, string> {
  const out = {} as Record<RoleName, string>
  for (const role of ROLE_NAMES) out[role] = resolveRoleModel(role, env)
  return out
}

/** Default project dir: env.VAJRA_PROJECT_DIR > config.json > cwd. */
export function resolveDefaultDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DEFAULT_DIR_KEY]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return readConfig(env).projectDir ?? process.cwd()
}

/** True when the value comes from config.json rather than a fallback. */
export function isPersistedDefault(key: ConfigKey, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(readConfig(env)[key])
}

/**
 * Persist defaults so they survive a restart (config.json) and return its
 * path, so the UI can show where they went.
 */
export function saveDefaults(values: Partial<VajraConfig>, env: NodeJS.ProcessEnv = process.env): string {
  return writeConfig(values, env)
}

/** Where a resolved value came from, for `vajra config -l`. */
export type ConfigSource = 'env' | 'config' | 'default'

/**
 * Provenance for one key: the env var if it is set, config.json if it is
 * written there, and 'default' for a value that fell through to the built-in.
 */
export function configSource(key: ConfigKey, env: NodeJS.ProcessEnv = process.env): ConfigSource {
  const config = readConfig(env)
  if (key === 'model') {
    if ((env.VAJRA_MODEL || env.DEFAULT_MODEL)?.trim()) return 'env'
    return config.model ? 'config' : 'default'
  }
  if (key === 'projectDir') {
    if (env[DEFAULT_DIR_KEY]?.trim()) return 'env'
    return config.projectDir ? 'config' : 'default'
  }
  const role = key.replace(/Model$/, '').toLowerCase() as RoleName
  if (env[roleModelEnvKey(role)]?.trim()) return 'env'
  return config[key] ? 'config' : 'default'
}
