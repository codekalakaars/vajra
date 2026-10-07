// @codekalakaars/vajra-sandbox: the policy and the guards a confined shell is built from.
//
// What is here: the Linux-only platform check, the file policy (glob rules,
// compiled to the permissions the native addon enforces with Landlock), the
// `.vajra-sandbox.json` file that stores it, secret masking, change history for
// rollback, and freezing a process tree. The native addon does the confining.

export { createSandboxConfig, type SandboxConfig, type SandboxEnvironments, type FileRule, type CreateSandboxInput } from './config.js'
export {
  SUPPORTED_PLATFORMS,
  isSupportedPlatform,
  unsupportedPlatformMessage,
  assertSupportedPlatform,
  type SupportedPlatform,
} from './platform.js'
export { matchesPattern, resolveFilePermission, resolveFilePermissions, filterFileEntries } from './file-rules.js'
export { loadSandboxConfig, loadSandboxEnvironments, saveSandboxConfig, saveSandboxEnvironments, DEFAULT_CONFIG_FILE } from './file-config.js'
export { ChangeHistory, type TaskChanges } from './change-history.js'
export { descendants, freezeTree, thawTree } from './freeze.js'
export { sandboxCapabilities, applySandbox, type SandboxCapabilities, type SandboxResult } from './native.js'
export { isMaskedName, scanProject, defaultPermissions, loadPermissions, permissionsFor, loadEnvFile, redact, runCommandAsyncTimeout, type EnvVar } from './native.js'
export type { FilePermissions, PermissionsConfig, ProjectFileEntry } from './types.js'
