// Per-worker resource limits for parallel task execution.
//
// These limits are passed to the sandboxed worker via the LaunchJob and
// enforced at the worker level. They prevent a single task from consuming
// excessive resources and starving other parallel workers.

/** Resource limits for a single worker process. */
export interface ResourceLimits {
  /** Maximum heap memory in MB (default: 512). */
  maxMemoryMB?: number
  /** Maximum CPU time in ms before the worker is killed (default: 300000). */
  maxCpuTimeMs?: number
  /** Maximum total tool calls before the worker rejects further requests (default: 100). */
  maxToolCalls?: number
  /** Maximum number of restart attempts on unexpected exit (default: 2). */
  maxSpawnRetries?: number
}

/** Default resource limits applied when none are specified. */
export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = {
  maxMemoryMB: 512,
  maxCpuTimeMs: 300_000,
  maxToolCalls: 100,
  maxSpawnRetries: 2,
}

/** Merge user-provided limits with defaults. */
export function resolveResourceLimits(
  input?: ResourceLimits,
): Required<ResourceLimits> {
  return {
    maxMemoryMB: input?.maxMemoryMB ?? DEFAULT_RESOURCE_LIMITS.maxMemoryMB,
    maxCpuTimeMs: input?.maxCpuTimeMs ?? DEFAULT_RESOURCE_LIMITS.maxCpuTimeMs,
    maxToolCalls: input?.maxToolCalls ?? DEFAULT_RESOURCE_LIMITS.maxToolCalls,
    maxSpawnRetries: input?.maxSpawnRetries ?? DEFAULT_RESOURCE_LIMITS.maxSpawnRetries,
  }
}

/** Concurrency configuration for the worker pool. */
export interface ConcurrencyConfig {
  /** Maximum workers running simultaneously (default: 4). */
  maxConcurrentWorkers: number
  /** Number of idle workers to keep warm for fast startup (default: 1). */
  maxIdleWorkers: number
  /** Timeout in ms before an idle worker is destroyed (default: 60000). */
  idleTimeoutMs: number
  /** Interval in ms for health check pings (default: 10000). */
  healthCheckIntervalMs: number
}

/** Default concurrency config. */
export const DEFAULT_CONCURRENCY: Required<ConcurrencyConfig> = {
  maxConcurrentWorkers: 4,
  maxIdleWorkers: 1,
  idleTimeoutMs: 60_000,
  healthCheckIntervalMs: 10_000,
}

/** Merge user-provided concurrency config with defaults. */
export function resolveConcurrencyConfig(
  input?: Partial<ConcurrencyConfig>,
): Required<ConcurrencyConfig> {
  return {
    maxConcurrentWorkers: input?.maxConcurrentWorkers ?? DEFAULT_CONCURRENCY.maxConcurrentWorkers,
    maxIdleWorkers: input?.maxIdleWorkers ?? DEFAULT_CONCURRENCY.maxIdleWorkers,
    idleTimeoutMs: input?.idleTimeoutMs ?? DEFAULT_CONCURRENCY.idleTimeoutMs,
    healthCheckIntervalMs: input?.healthCheckIntervalMs ?? DEFAULT_CONCURRENCY.healthCheckIntervalMs,
  }
}
