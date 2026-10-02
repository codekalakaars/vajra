import { readFileSync } from 'node:fs'
import { reasoningLevelsFor, type ReasoningEffort } from '../model/catalog.js'
import { TODAYS_PARAMS, type ReadLockMode, type ScheduleOrder, type WorkerParams } from './params.js'

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
  // Only the OpenCode Zen gateway is supported.
  if (!workerModel.startsWith('zen/') && !workerModel.startsWith('go/')) {
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

