// Tool access restriction.
// Filters tool names based on SandboxConfig's allowedTools list.
// Has zero dependency on @vajra/protocol — standalone.

import type { SandboxConfig } from './config.js'

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

const ROLE_DEFAULTS: Record<string, ToolName[]> = {
  manager: ['read_file', 'list_files'],
  master: ['read_file', 'list_files', 'run_command'],
  worker: ['read_file', 'list_files', 'write_file', 'edit_file', 'delete_file', 'create_dir', 'copy_file', 'rename_file'],
}

/**
 * Resolve the list of tool names a worker is allowed to call.
 * Priority: config.allowedTools > role defaults > all known tools.
 * Unknown names are silently dropped.
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
