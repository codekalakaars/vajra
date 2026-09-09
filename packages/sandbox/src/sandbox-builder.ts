// Translates a SandboxConfig into the LaunchJob shape that the sandboxed
// worker (sandboxed-worker.mjs) expects.
//
// This bridge exists so the server doesn't need to know how SandboxConfig
// maps to worker parameters — the sandbox package owns that translation.

import type { SandboxConfig } from './config.js'
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
  allowUnenforced: boolean
  allowedTools?: string[]
}

/**
 * Build a LaunchJob from a SandboxConfig.
 *
 * The worker receives this object as its initial IPC message and uses it to:
 *  1. Apply the native sandbox (via vajra-native's applySandbox)
 *  2. Filter tool calls (via the allowedTools list)
 */
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
    allowUnenforced: config.allowUnenforced,
    allowedTools,
  }
}
