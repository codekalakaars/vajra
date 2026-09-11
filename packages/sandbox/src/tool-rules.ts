// Tool access restriction.
//
// Filters tool names based on a SandboxConfig. The sandbox config specifies
// which tool names are allowed; the worker enforces this list at dispatch time.
//
// This module has zero dependency on @vajra/protocol — the known tool names
// are defined here so the sandbox package stays standalone.

import type { SandboxConfig } from './config.js'

/** All known tool names across the system. */
export const KNOWN_TOOLS = [
  // File operations
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'copy_file',
  'rename_file',
  // Directory operations
  'create_dir',
  'delete_dir',
  'list_files',
  // Process execution
  'run_command',
  // KiCad tools
  'parse_schematic',
  'generate_pcb',
  'run_drc',
  'export_gerbers',
  'export_bom',
] as const

export type ToolName = (typeof KNOWN_TOOLS)[number]

/** Default tools per agent role. Used when no explicit allowedTools is set. */
const ROLE_DEFAULTS: Record<string, ToolName[]> = {
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
 * Every returned name is validated against `KNOWN_TOOLS` — unknown names
 * are silently dropped rather than producing a tool the worker cannot dispatch.
 */
export function resolveAllowedTools(
  config: SandboxConfig,
  role?: string,
): string[] {
  const knownSet = new Set<string>(KNOWN_TOOLS)

  let candidates: string[]

  if (config.allowedTools !== null) {
    candidates = [...config.allowedTools]
  } else if (role && ROLE_DEFAULTS[role]) {
    candidates = [...ROLE_DEFAULTS[role]]
  } else {
    candidates = [...KNOWN_TOOLS]
  }

  return candidates.filter((name) => knownSet.has(name))
}
