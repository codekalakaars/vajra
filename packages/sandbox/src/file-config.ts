// File-based sandbox configuration persistence.
//
// Loads and saves `.vajra-sandbox.json` in a project directory. This file
// lets users configure sandbox rules outside of code — the server reads it
// when creating a session and passes the resulting SandboxConfig to the worker.
//
// Supports two formats:
//  1. Flat — a single config at the top level (backward compatible)
//  2. Environments — named configs under an "environments" key

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxConfig, FileRule, CreateSandboxInput, SandboxEnvironments } from './config.js'
import { createSandboxConfig } from './config.js'

export const DEFAULT_CONFIG_FILE = '.vajra-sandbox.json'

/** On-disk shape of .vajra-sandbox.json (looser than SandboxConfig). */
interface PersistedConfig {
  version?: number
  defaultPermissions?: {
    read?: boolean
    write?: boolean
    edit?: boolean
    delete?: boolean
  }
  fileRules?: Array<{
    pattern: string
    read?: boolean
    write?: boolean
    edit?: boolean
    delete?: boolean
  }>
  allowedTools?: string[]
  allowUnenforced?: boolean
  readExecutePaths?: string[]
  readWritePaths?: string[]
  /** Named environments. Each value has the same shape as the flat config. */
  environments?: Record<string, Omit<PersistedConfig, 'environments'>>
}

function parseConfig(
  raw: PersistedConfig,
  projectDir: string,
): CreateSandboxInput {
  return {
    projectDir,
    defaultPermissions: raw.defaultPermissions
      ? {
          read: raw.defaultPermissions.read ?? true,
          write: raw.defaultPermissions.write ?? false,
          edit: raw.defaultPermissions.edit ?? false,
          delete: raw.defaultPermissions.delete ?? false,
        }
      : undefined,
    fileRules: raw.fileRules?.map((r): FileRule => ({
      pattern: r.pattern,
      read: r.read,
      write: r.write,
      edit: r.edit,
      delete: r.delete,
    })),
    allowedTools: raw.allowedTools,
    allowUnenforced: raw.allowUnenforced,
    readExecutePaths: raw.readExecutePaths,
    readWritePaths: raw.readWritePaths,
  }
}

/**
 * Load all named environments from `.vajra-sandbox.json`.
 *
 * If the file uses the flat format (no `environments` key), returns a single
 * environment named `"default"`. Returns an empty map when the file is absent
 * or unparseable.
 */
export function loadSandboxEnvironments(projectDir: string): SandboxEnvironments {
  const path = join(projectDir, DEFAULT_CONFIG_FILE)
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return {}
  }

  let parsed: PersistedConfig
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  const result: SandboxEnvironments = {}

  if (parsed.environments) {
    for (const [name, envRaw] of Object.entries(parsed.environments)) {
      result[name] = createSandboxConfig(parseConfig(envRaw, projectDir))
    }
  } else {
    // Flat format — wrap as a single "default" environment
    result['default'] = createSandboxConfig(parseConfig(parsed, projectDir))
  }

  return result
}

/**
 * Load a SandboxConfig from `.vajra-sandbox.json` in the project directory.
 *
 *  - `loadSandboxConfig(projectDir)` — loads the flat config or the "default" environment
 *  - `loadSandboxConfig(projectDir, 'editor')` — loads the named environment
 *
 * Returns null when the file is absent, unparseable, or the named environment
 * doesn't exist.
 */
export function loadSandboxConfig(
  projectDir: string,
  environment?: string,
): SandboxConfig | null {
  const envs = loadSandboxEnvironments(projectDir)
  const key = environment ?? 'default'
  return envs[key] ?? null
}

/** On-disk serializable subset of SandboxConfig. */
interface SerializedConfig {
  version: number
  defaultPermissions: { read: boolean; write: boolean; edit: boolean; delete: boolean }
  fileRules: Array<{ pattern: string; read?: boolean; write?: boolean; edit?: boolean; delete?: boolean }>
  allowedTools: string[] | null
  allowUnenforced: boolean
  readExecutePaths: string[]
  readWritePaths: string[]
}

function serializeConfig(config: SandboxConfig): SerializedConfig {
  return {
    version: config.version,
    defaultPermissions: { ...config.defaultPermissions },
    fileRules: config.fileRules.map((r) => ({
      pattern: r.pattern,
      ...(r.read !== undefined && { read: r.read }),
      ...(r.write !== undefined && { write: r.write }),
      ...(r.edit !== undefined && { edit: r.edit }),
      ...(r.delete !== undefined && { delete: r.delete }),
    })),
    allowedTools: config.allowedTools ? [...config.allowedTools] : null,
    allowUnenforced: config.allowUnenforced,
    readExecutePaths: [...config.readExecutePaths],
    readWritePaths: [...config.readWritePaths],
  }
}

/**
 * Save a SandboxConfig to `.vajra-sandbox.json` in the project directory.
 *
 * Writes the flat format (no `environments` key) — suitable when there's
 * only one config. For multiple environments, use `saveSandboxEnvironments`.
 */
export function saveSandboxConfig(projectDir: string, config: SandboxConfig): void {
  const path = join(projectDir, DEFAULT_CONFIG_FILE)
  writeFileSync(path, JSON.stringify(serializeConfig(config), null, 2) + '\n', 'utf-8')
}

/**
 * Save multiple named environments to `.vajra-sandbox.json`.
 */
export function saveSandboxEnvironments(
  projectDir: string,
  environments: SandboxEnvironments,
): void {
  const path = join(projectDir, DEFAULT_CONFIG_FILE)

  const serialized = {
    version: 1 as const,
    environments: Object.fromEntries(
      Object.entries(environments).map(([name, config]) => [name, serializeConfig(config)]),
    ),
  }

  writeFileSync(path, JSON.stringify(serialized, null, 2) + '\n', 'utf-8')
}
