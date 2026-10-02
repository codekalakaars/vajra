import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_MODEL, isSupportedModel, normalizeModelId } from './env.js'
import { configPath, ensureVajraHome, readJsonFile, writeJsonFile } from './home.js'
import { reasoningLevelsFor, type ReasoningEffort } from './models/catalog.js'
import { TODAYS_PARAMS, type ReadLockMode, type ScheduleOrder, type WorkerParams } from './bench/params.js'

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

/** Default project dir: env.VAJRA_PROJECT_DIR > config.json > cwd. */
export function resolveDefaultDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DEFAULT_DIR_KEY]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return readConfig(env).projectDir ?? process.cwd()
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

// --- bench config ----------------------------------------------------------
//
// `bench/config.json` is the whole arrangement of a run, and the *only* place it
// comes from. Nothing here consults the environment, `~/.vajra/config.json` or a
// built-in default: a sweep writes a complete candidate file, so a value that
// quietly fell back to a default would make two different candidates look like
// the same run.

/** A setup error in `bench/config.json`. `key` is the offending key, if any. */
export class WorkerParamsError extends Error {
  readonly key: string | null

  constructor(message: string, key: string | null = null) {
    super(message)
    this.name = 'WorkerParamsError'
    this.key = key
  }
}

const SCHEDULE_ORDERS: readonly string[] = ['plan', 'critical-path', 'most-dependents']
const READ_LOCK_MODES: readonly string[] = ['exclusive', 'shared']

function requireKey(raw: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in raw)) {
    throw new WorkerParamsError(`${path}: missing required key '${key}'`, key)
  }
  return raw[key]
}

function requireInteger(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
): number {
  const value = requireKey(raw, key, path)
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new WorkerParamsError(`${path}: '${key}' must be an integer, got ${JSON.stringify(value)}`, key)
  }
  if (value < min) {
    throw new WorkerParamsError(`${path}: '${key}' must be >= ${min}, got ${value}`, key)
  }
  return value
}

function requireFraction(raw: Record<string, unknown>, key: string, path: string): number {
  const value = requireKey(raw, key, path)
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new WorkerParamsError(`${path}: '${key}' must be a number in (0, 1], got ${JSON.stringify(value)}`, key)
  }
  return value
}

function requireBoolean(raw: Record<string, unknown>, key: string, path: string): boolean {
  const value = requireKey(raw, key, path)
  if (typeof value !== 'boolean') {
    throw new WorkerParamsError(`${path}: '${key}' must be true or false, got ${JSON.stringify(value)}`, key)
  }
  return value
}

function requireString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = requireKey(raw, key, path)
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkerParamsError(
      `${path}: '${key}' must be a non-empty string, got ${JSON.stringify(value)}`,
      key,
    )
  }
  return value
}

function requireOneOf(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly string[],
): string {
  const value = requireKey(raw, key, path)
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new WorkerParamsError(
      `${path}: '${key}' must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`,
      key,
    )
  }
  return value
}

/**
 * Read `bench/config.json` (or a sweep's candidate copy) into a `WorkerParams`.
 *
 * Every key is required and validated by hand, and a key that is missing or
 * wrong throws before a run starts rather than defaulting: a tuning run that
 * silently ran a different arrangement than the file describes would report a
 * median for something nobody asked to measure.
 *
 * `workerReasoning` is checked against `workerModel`, so `workerModel` is read
 * first — a level a model does not accept is a 400 waiting to happen.
 */
export function loadWorkerParams(path: string): WorkerParams {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new WorkerParamsError(
      code === 'ENOENT' ? `${path}: no such file` : `${path}: cannot be read (${code ?? 'unknown error'})`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new WorkerParamsError(`${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkerParamsError(`${path}: must be a JSON object`)
  }
  const raw = parsed as Record<string, unknown>

  // A typo'd key would otherwise be ignored, and a sweep would compare two
  // candidates that both quietly ran the default.
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(TODAYS_PARAMS, key)) {
      throw new WorkerParamsError(
        `${path}: unknown key '${key}' (known: ${Object.keys(TODAYS_PARAMS).join(', ')})`,
        key,
      )
    }
  }

  const workerModel = requireString(raw, 'workerModel', path)
  if (!isSupportedModel(workerModel)) {
    throw new WorkerParamsError(
      `${path}: 'workerModel' must be a zen/* or go/* model id, got '${workerModel}'`,
      'workerModel',
    )
  }
  const levels = reasoningLevelsFor(workerModel)
  const reasoning = requireOneOf(raw, 'workerReasoning', path, levels)
  const preloadReads = requireBoolean(raw, 'preloadReads', path)
  const elision = requireBoolean(raw, 'elision', path)
  const checkpoints = requireBoolean(raw, 'checkpoints', path)
  const elideAt = requireFraction(raw, 'elideAt', path)
  const compactAt = requireFraction(raw, 'compactAt', path)
  // With both rungs on, the cheap one has to fire first, or it never does.
  if (elision && checkpoints && compactAt <= elideAt) {
    throw new WorkerParamsError(
      `${path}: 'compactAt' (${compactAt}) must be above 'elideAt' (${elideAt}) when both 'elision' and 'checkpoints' are on`,
      'compactAt',
    )
  }

  const cpuPauseAt = requireFraction(raw, 'cpuPauseAt', path)
  const cpuResumeAt = requireFraction(raw, 'cpuResumeAt', path)
  // Equal thresholds would pause and resume on the same reading, every reading.
  if (cpuResumeAt >= cpuPauseAt) {
    throw new WorkerParamsError(
      `${path}: 'cpuResumeAt' (${cpuResumeAt}) must be below 'cpuPauseAt' (${cpuPauseAt})`,
      'cpuResumeAt',
    )
  }

  return {
    cpuPauseAt,
    cpuResumeAt,
    minFreeMemMb: requireInteger(raw, 'minFreeMemMb', path, 0),
    workerMemMb: requireInteger(raw, 'workerMemMb', path, 1),
    resourceSampleMs: requireInteger(raw, 'resourceSampleMs', path, 50),
    scheduleOrder: requireOneOf(raw, 'scheduleOrder', path, SCHEDULE_ORDERS) as ScheduleOrder,
    readLocks: requireOneOf(raw, 'readLocks', path, READ_LOCK_MODES) as ReadLockMode,
    workerModel,
    workerReasoning: reasoning as ReasoningEffort,
    workerMaxToolCalls: requireInteger(raw, 'workerMaxToolCalls', path, 1),
    taskTimeoutSec: requireInteger(raw, 'taskTimeoutSec', path, 1),
    retries: requireInteger(raw, 'retries', path, 0),
    preloadReads,
    toolOutputMaxChars: requireInteger(raw, 'toolOutputMaxChars', path, 1000),
    contextPack: requireBoolean(raw, 'contextPack', path),
    packWindowShare: requireFraction(raw, 'packWindowShare', path),
    anchorContextLines: requireInteger(raw, 'anchorContextLines', path, 0),
    elision,
    elideAt,
    keepRecentRounds: requireInteger(raw, 'keepRecentRounds', path, 1),
    elidedTailLines: requireInteger(raw, 'elidedTailLines', path, 1),
    checkpoints,
    compactAt,
    stuckCheckpointShare: requireFraction(raw, 'stuckCheckpointShare', path),
    maxCompactionsWithoutProgress: requireInteger(raw, 'maxCompactionsWithoutProgress', path, 1),
    checkpointDiffChars: requireInteger(raw, 'checkpointDiffChars', path, 0),
    respawnContext: requireBoolean(raw, 'respawnContext', path),
    respawnDiffChars: requireInteger(raw, 'respawnDiffChars', path, 0),
    handoffSummaryChars: requireInteger(raw, 'handoffSummaryChars', path, 100),
    warmSandboxes: requireInteger(raw, 'warmSandboxes', path, 0),
  }
}

