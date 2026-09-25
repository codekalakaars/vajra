// Tool access restriction.
//
// Filters the tool definitions from @codekalakaars/vajra-protocol based on a
// SandboxConfig. The sandbox config specifies which tool names are allowed;
// the worker enforces this list at dispatch time.

import { toolDefinitions, roleTools, type ToolName } from '@codekalakaars/vajra-protocol'
import type { SandboxConfig } from './config.js'

/**
 * Resolve the list of tool names a worker is allowed to call.
 *
 * Priority:
 *  1. If `config.allowedTools` is set, use it (explicit allowlist).
 *  2. If `role` is provided, use the protocol's canonical `roleTools[role]`
 *     (contract C2 — do not reintroduce a rival ROLE_DEFAULTS table).
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
  } else if (role && roleTools[role]) {
    candidates = [...roleTools[role]]
  } else {
    candidates = Object.keys(toolDefinitions)
  }

  return candidates.filter((name) => knownTools.has(name))
}
