// Core sandbox configuration types and builder.
//
// A SandboxConfig is an immutable description of what a sandboxed worker may
// access: which files (by glob pattern) and which tools (by name). The config
// is built by the parent process and passed to the worker — the worker never
// modifies it.

import type { FilePermissions } from './types.js'
import type { ConcurrencyConfig } from './resources.js'
import { resolveConcurrencyConfig } from './resources.js'

/** A single file access rule, matched against project-relative paths. */
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
  /** Permissions applied to files with no matching rule. */
  defaultPermissions?: FilePermissions
  /** File access rules, evaluated in array order (later overrides earlier). */
  fileRules?: FileRule[]
  /** Tool names the worker may call. If omitted, all tools are allowed. */
  allowedTools?: string[]
  /** Proceed on a platform with no enforcement. */
  allowUnenforced?: boolean
  /** Extra paths granted read+execute (toolchains, interpreters). */
  readExecutePaths?: string[]
  /** Extra paths granted read+write (agent state, logs). */
  readWritePaths?: string[]
  /** Concurrency config for parallel worker execution. */
  concurrency?: Partial<ConcurrencyConfig>
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
  readonly concurrency: Required<ConcurrencyConfig>
}

/** Map of environment name → sandbox config. */
export type SandboxEnvironments = Record<string, SandboxConfig>

const DEFAULT_FILE_PERMISSIONS: FilePermissions = {
  read: true,
  write: false,
  edit: false,
  delete: false,
}

/**
 * Build an immutable sandbox configuration.
 *
 * The result is frozen — to change rules, create a new config rather than
 * mutating this one. This prevents accidental drift between what the parent
 * process intended and what the worker enforces.
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
    concurrency: resolveConcurrencyConfig(input.concurrency),
  }
  return Object.freeze(config)
}
