// @codekalakaars/sandbox — programmatically configurable sandbox policy.
//
// Provides a TypeScript API for building sandbox configurations that restrict
// what files a worker can access and what tools it can call. The config is
// built by the parent process and passed to the sandboxed worker — the worker
// never modifies it.
//
// CLI usage:
//   vajra-sandbox status   — check sandbox capabilities
//   vajra-sandbox config   — create/view .vajra-sandbox.json
//   vajra-sandbox test     — test if sandbox works

export { createSandboxConfig, type SandboxConfig, type SandboxEnvironments, type FileRule, type CreateSandboxInput } from './config.js'
export { matchesPattern, resolveFilePermission, resolveFilePermissions, filterFileEntries, checkToolPermission } from './file-rules.js'
export { resolveAllowedTools } from './tool-rules.js'
export { buildLaunchJob, type LaunchJob } from './sandbox-builder.js'
export { loadSandboxConfig, loadSandboxEnvironments, saveSandboxConfig, saveSandboxEnvironments, DEFAULT_CONFIG_FILE } from './file-config.js'
export { FileLockManager, type Lock, type LockMode } from './file-locks.js'
export { type ResourceLimits, type ConcurrencyConfig, DEFAULT_RESOURCE_LIMITS, DEFAULT_CONCURRENCY, resolveResourceLimits, resolveConcurrencyConfig } from './resources.js'
export { ChangeHistory, type FileChange, type TaskChanges } from './change-history.js'
export {
  createWorktree,
  mergeWorktree,
  discardWorktree,
  getChangedFiles,
  cleanupWorktrees,
  type WorktreeInfo,
  type WorktreeResult,
} from './worktree.js'

export {
  WorkerPool,
  type PoolWorker,
  type PoolWorkerFactory,
  type PoolStats,
  type WorkerLease,
  type WorkerPoolOptions,
} from './pool.js'
