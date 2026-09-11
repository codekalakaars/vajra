// Shared types for sandbox configuration.
//
// These mirror vajra-core's own types (FilePermissions, PermissionsConfig,
// ProjectFileEntry) but are kept here so @vajra/sandbox has zero dependency
// on @vajra/protocol or vajra-core. The shapes must stay in sync — a
// mismatch is a bug.

/** Per-file access permissions. */
export interface FilePermissions {
  read: boolean
  write: boolean
  edit: boolean
  delete: boolean
}

/** Project-wide permissions config, persisted as .vajra-perms.json. */
export interface PermissionsConfig {
  version: number
  /** Applied to any path without an entry in `files`. */
  default: FilePermissions
  /** Per-path overrides, keyed by project-relative path with `/` separators. */
  files: Record<string, FilePermissions>
}

/** A file or directory entry from scanning a project. */
export interface ProjectFileEntry {
  name: string
  /** Project-relative, always `/`-separated. */
  path: string
  isDir: boolean
  /** True for env files whose contents the agent must not see. */
  isMasked: boolean
}
