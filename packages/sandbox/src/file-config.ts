// File-based sandbox configuration persistence.
// Loads and saves `.vajra-sandbox.json` in a project directory.
// Supports two formats: flat (single config) and environments (named configs).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxConfig, FileRule, CreateSandboxInput, SandboxEnvironments } from './config.js'
import { createSandboxConfig } from './config.js'

export const DEFAULT_CONFIG_FILE = '.vajra-sandbox.json'

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
 * If flat format (no `environments` key), returns a single "default" environment.
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
    result['default'] = createSandboxConfig(parseConfig(parsed, projectDir))
  }

  return result
}

/**
 * Load a SandboxConfig from `.vajra-sandbox.json`.
 *  - `loadSandboxConfig(projectDir)` — loads flat or "default" environment
 *  - `loadSandboxConfig(projectDir, 'editor')` — loads named environment
 */
export function loadSandboxConfig(
  projectDir: string,
  environment?: string,
): SandboxConfig | null {
  const envs = loadSandboxEnvironments(projectDir)
  const key = environment ?? 'default'
  return envs[key] ?? null
}

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

/** Save a SandboxConfig (flat format). */
export function saveSandboxConfig(projectDir: string, config: SandboxConfig): void {
  const path = join(projectDir, DEFAULT_CONFIG_FILE)
  writeFileSync(path, JSON.stringify(serializeConfig(config), null, 2) + '\n', 'utf-8')
}

/** Save multiple named environments. */
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
