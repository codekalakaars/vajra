// Resource limits and concurrency configuration for sandboxed workers.

/** Maximum number of concurrent file operations per agent. */
export const DEFAULT_MAX_CONCURRENT_OPS = 10

/** Maximum number of agents that can connect simultaneously. */
export const DEFAULT_MAX_AGENTS = 4

/** Default file lock timeout in milliseconds (5 minutes). */
export const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000

/** Maximum number of open file descriptors per worker process. */
export const DEFAULT_MAX_OPEN_FILES = 256

/** Default concurrency configuration. */
export interface ConcurrencyConfig {
  /** Maximum concurrent file operations per agent. */
  maxConcurrentOps: number
  /** Maximum simultaneous agent connections. */
  maxAgents: number
  /** File lock timeout in ms (0 = no timeout). */
  lockTimeoutMs: number
  /** Maximum open file descriptors per worker. */
  maxOpenFiles: number
}

/** Resource limits applied to a worker process. */
export interface ResourceLimits {
  /** Maximum memory in bytes (0 = unlimited). */
  maxMemoryBytes: number
  /** Maximum CPU time in seconds (0 = unlimited). */
  maxCpuSeconds: number
  /** Maximum file size in bytes (0 = unlimited). */
  maxFileSize: number
  /** Maximum number of child processes. */
  maxProcesses: number
}

/** Default resource limits (all unlimited — sandboxing is the confinement). */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxMemoryBytes: 0,
  maxCpuSeconds: 0,
  maxFileSize: 0,
  maxProcesses: 0,
}

/** Default concurrency config. */
export const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  maxConcurrentOps: DEFAULT_MAX_CONCURRENT_OPS,
  maxAgents: DEFAULT_MAX_AGENTS,
  lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
  maxOpenFiles: DEFAULT_MAX_OPEN_FILES,
}
