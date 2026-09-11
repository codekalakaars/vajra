// Shared types for sandbox configuration.
// These mirror vajra-core's own types but are kept here so the sandbox
// package has zero dependency on vajra-core.

export interface FilePermissions {
  read: boolean
  write: boolean
  edit: boolean
  delete: boolean
}

export interface PermissionsConfig {
  version: number
  default: FilePermissions
  /** Per-path overrides, keyed by project-relative path with `/` separators. */
  files: Record<string, FilePermissions>
}

export interface ProjectFileEntry {
  name: string
  /** Project-relative, always `/`-separated. */
  path: string
  isDir: boolean
  /** True for env files whose contents the agent must not see. */
  isMasked: boolean
}
