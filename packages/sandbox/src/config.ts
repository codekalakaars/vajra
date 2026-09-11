// Core sandbox configuration types and builder.
// A SandboxConfig is immutable — the worker never modifies it.

import type { FilePermissions } from './types.js'

export interface FileRule {
  /** Glob pattern: "src/**", "*.ts", "!*.env". Negation with ! prefix revokes. */
  pattern: string
  read?: boolean
  write?: boolean
  edit?: boolean
  delete?: boolean
}

export interface CreateSandboxInput {
  projectDir: string
  defaultPermissions?: FilePermissions
  /** Evaluated in array order (later overrides earlier). */
  fileRules?: FileRule[]
  allowedTools?: string[]
  allowUnenforced?: boolean
  readExecutePaths?: string[]
  readWritePaths?: string[]
}

export interface SandboxConfig {
  readonly version: 1
  readonly projectDir: string
  readonly defaultPermissions: FilePermissions
  readonly fileRules: readonly FileRule[]
  readonly allowedTools: readonly string[] | null
  readonly allowUnenforced: boolean
  readonly readExecutePaths: readonly string[]
  readonly readWritePaths: readonly string[]
}

export type SandboxEnvironments = Record<string, SandboxConfig>

const DEFAULT_FILE_PERMISSIONS: FilePermissions = {
  read: true,
  write: false,
  edit: false,
  delete: false,
}

/**
 * Build an immutable sandbox configuration. The result is frozen —
 * to change rules, create a new config rather than mutating this one.
 */
export function createSandboxConfig(input: CreateSandboxInput): SandboxConfig {
  const config: SandboxConfig = {
    version: 1,
    projectDir: input.projectDir,
    defaultPermissions: input.defaultPermissions ?? { ...DEFAULT_FILE_PERMISSIONS },
    fileRules: Object.freeze([...(input.fileRules ?? [])]),
    allowedTools: input.allowedTools ? Object.freeze([...input.allowedTools]) : null,
    allowUnenforced: input.allowUnenforced ?? false,
    readExecutePaths: Object.freeze([...(input.readExecutePaths ?? [])]),
    readWritePaths: Object.freeze([...(input.readWritePaths ?? [])]),
  }
  return Object.freeze(config)
}
