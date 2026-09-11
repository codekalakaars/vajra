// Translates a SandboxConfig into the LaunchJob shape the worker expects.

import type { SandboxConfig, FileRule } from './config.js'
import type { FilePermissions } from './types.js'
import { resolveFilePermissions } from './file-rules.js'
import { resolveAllowedTools } from './tool-rules.js'

/** The shape sandboxed-worker.mjs receives via IPC as its initial job. */
export interface LaunchJob {
  sessionId: string
  projectDir: string
  permissions: {
    version: number
    default: { read: boolean; write: boolean; edit: boolean; delete: boolean }
    files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>
  }
  fileRules?: readonly FileRule[]
  defaultFilePermissions?: FilePermissions
  allowUnenforced: boolean
  allowedTools?: string[]
}

/** Build a LaunchJob from a SandboxConfig. */
export function buildLaunchJob(
  config: SandboxConfig,
  sessionId: string,
): LaunchJob {
  const permissions = resolveFilePermissions(config)
  const allowedTools = config.allowedTools !== null
    ? resolveAllowedTools(config)
    : undefined

  return {
    sessionId,
    projectDir: config.projectDir,
    permissions,
    fileRules: config.fileRules,
    defaultFilePermissions: config.defaultPermissions,
    allowUnenforced: config.allowUnenforced,
    allowedTools,
  }
}
