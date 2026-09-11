// Resource limits and concurrency configuration for sandboxed workers.

export const DEFAULT_MAX_CONCURRENT_OPS = 10
export const DEFAULT_MAX_AGENTS = 4
export const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
export const DEFAULT_MAX_OPEN_FILES = 256

export interface ConcurrencyConfig {
  maxConcurrentOps: number
  maxAgents: number
  /** File lock timeout in ms (0 = no timeout). */
  lockTimeoutMs: number
  maxOpenFiles: number
}

export interface ResourceLimits {
  /** 0 = unlimited */
  maxMemoryBytes: number
  /** 0 = unlimited */
  maxCpuSeconds: number
  /** 0 = unlimited */
  maxFileSize: number
  maxProcesses: number
}

/** All unlimited — sandboxing is the confinement. */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxMemoryBytes: 0,
  maxCpuSeconds: 0,
  maxFileSize: 0,
  maxProcesses: 0,
}

export const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  maxConcurrentOps: DEFAULT_MAX_CONCURRENT_OPS,
  maxAgents: DEFAULT_MAX_AGENTS,
  lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
  maxOpenFiles: DEFAULT_MAX_OPEN_FILES,
}
