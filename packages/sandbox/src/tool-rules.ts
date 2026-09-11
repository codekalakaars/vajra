// Tool access restriction.
//
// Filters the tool definitions from @codekalakaars/protocol based on a SandboxConfig.
// The sandbox config specifies which tool names are allowed; the worker enforces
// this list at dispatch time.

import { toolDefinitions, type ToolName } from '@codekalakaars/protocol'
import type { SandboxConfig } from './config.js'

/** Default tools per agent role. Used when no explicit allowedTools is set. */
const ROLE_DEFAULTS: Record<string, string[]> = {
  manager: ['read_file', 'list_files'],
  master: ['read_file', 'list_files', 'run_command'],
  worker: ['read_file', 'list_files', 'write_file', 'edit_file', 'delete_file', 'create_dir', 'copy_file', 'rename_file'],
}

/**
 * Resolve the list of tool names a worker is allowed to call.
 *
 * Priority:
 *  1. If `config.allowedTools` is set, use it (explicit allowlist).
 *  2. If `role` is provided, use `ROLE_DEFAULTS[role]` as the base.
 *  3. If neither is set, all known tools are allowed.
 *
 * Every returned name is validated against `toolDefinitions` — unknown names
 * are silently dropped rather than producing a tool the worker cannot dispatch.
 */
export function resolveAllowedTools(
  config: SandboxConfig,
  role?: string,
): string[] {
  const knownTools = new Set(Object.keys(toolDefinitions))

  let candidates: string[]

  if (config.allowedTools !== null) {
    candidates = [...config.allowedTools]
  } else if (role && ROLE_DEFAULTS[role]) {
    candidates = [...ROLE_DEFAULTS[role]]
  } else {
    candidates = Object.keys(toolDefinitions)
  }

  return candidates.filter((name) => knownTools.has(name))
}
