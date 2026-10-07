import {
  scanProject as nativeScanProject,
  defaultPermissions as nativeDefaultPermissions,
  loadPermissions as nativeLoadPermissions,
  permissionsFor as nativePermissionsFor,
  runCommandAsyncTimeout as nativeRunCommandAsyncTimeout,
  loadEnvFile as nativeLoadEnvFile,
  redact as nativeRedact,
} from '@codekalakaars/vajra-native'

// Re-exported as they are: the addon's own types describe them exactly.
export { sandboxCapabilities, applySandbox, type SandboxCapabilities, type SandboxResult } from '@codekalakaars/vajra-native'
import type { PermissionsConfig, ProjectFileEntry } from './types.js'

/** Shape returned by the native `loadEnvFile` / consumed by `redact`. */
export interface EnvVar {
  key: string
  value: string
}

/** Public template suffixes that must remain readable. */
const PUBLIC_ENV_SUFFIXES = new Set([
  'example',
  'sample',
  'template',
  'defaults',
  'default',
  'dist',
])

/**
 * Basename masking rule — mirrors permissions.rs is_masked.
 * Masks `.env` and environment-specific variants such as `.env.local`,
 * `.env.production`, and `.env.development`, while leaving public templates
 * like `.env.example` readable.
 */
export function isMaskedName(name: string): boolean {
  if (name === '.env') return true
  if (!name.startsWith('.env.')) return false
  const segments = name.slice('.env.'.length).split('.')
  return !segments.some((segment) => PUBLIC_ENV_SUFFIXES.has(segment.toLowerCase()))
}

export function scanProject(projectDir: string): ProjectFileEntry[] {
  return nativeScanProject(projectDir)
}

export function defaultPermissions(): PermissionsConfig {
  return nativeDefaultPermissions()
}

export function loadPermissions(projectDir: string): PermissionsConfig | null {
  return nativeLoadPermissions(projectDir)
}

export function permissionsFor(config: PermissionsConfig, path: string) {
  return nativePermissionsFor(config, path)
}

export function runCommandAsyncTimeout(
  command: string,
  args: string[] | undefined,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return nativeRunCommandAsyncTimeout(command, args, cwd, timeoutMs)
}

export function loadEnvFile(path: string): EnvVar[] {
  return nativeLoadEnvFile(path)
}

export function redact(text: string, secrets: EnvVar[]): string {
  return nativeRedact(text, secrets)
}
