import {
  scanProject as nativeScanProject,
  readFile as nativeReadFile,
  writeFile as nativeWriteFile,
  editFile as nativeEditFile,
  listFiles as nativeListFiles,
  defaultPermissions as nativeDefaultPermissions,
  loadPermissions as nativeLoadPermissions,
  permissionsFor as nativePermissionsFor,
  deleteFile as nativeDeleteFile,
  createDir as nativeCreateDir,
  runCommandAsync as nativeRunCommandAsync,
  runCommandAsyncTimeout as nativeRunCommandAsyncTimeout,
  loadEnvFile as nativeLoadEnvFile,
  redact as nativeRedact,
} from '@codekalakaars/vajra-core'
import type { PermissionsConfig, ProjectFileEntry } from '@codekalakaars/vajra-protocol'

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

export function readFile(path: string): string {
  return nativeReadFile(path)
}

export function writeFile(path: string, content: string): void {
  nativeWriteFile(path, content)
}

export function editFile(path: string, oldString: string, newString: string, replaceAll?: boolean): void {
  nativeEditFile(path, oldString, newString, replaceAll)
}

export function deleteFile(path: string): void {
  nativeDeleteFile(path)
}

export function createDir(path: string): void {
  nativeCreateDir(path)
}

export function listFiles(path: string, recursive?: boolean): ProjectFileEntry[] {
  const entries = nativeListFiles(path, recursive)
  return entries.map(e => ({
    name: e.name,
    path: e.path,
    isDir: e.isDir,
    isMasked: !e.isDir && isMaskedName(e.name),
  }))
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

export function runCommandAsync(
  command: string,
  args?: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return nativeRunCommandAsync(command, args, cwd)
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
