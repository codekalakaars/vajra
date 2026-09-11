// @vajra/sandbox — programmatically configurable sandbox policy.
//
// Provides a TypeScript API for building sandbox configurations that restrict
// what files a worker can access and what tools it can call. The config is
// built by the parent process and passed to the sandboxed worker — the worker
// never modifies it.

export type { FilePermissions, PermissionsConfig, ProjectFileEntry } from './types.js'
export { createSandboxConfig, type SandboxConfig, type SandboxEnvironments, type FileRule, type CreateSandboxInput } from './config.js'
export { matchesPattern, resolveFilePermission, resolveFilePermissions, filterFileEntries } from './file-rules.js'
export { resolveAllowedTools, KNOWN_TOOLS, type ToolName } from './tool-rules.js'
export { buildLaunchJob, type LaunchJob } from './sandbox-builder.js'
export { loadSandboxConfig, loadSandboxEnvironments, saveSandboxConfig, saveSandboxEnvironments, DEFAULT_CONFIG_FILE } from './file-config.js'
export { FileLockManager, type FileLock, type LockMode, type LockResult } from './file-locks.js'
export { SandboxDaemon, type DaemonConfig } from './daemon.js'
export { SandboxClient, type ClientConfig } from './client.js'
export { DEFAULT_CONCURRENCY, DEFAULT_RESOURCE_LIMITS, type ConcurrencyConfig, type ResourceLimits } from './resources.js'
