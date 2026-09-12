import {
  scanProject as nativeScanProject,
  readFile as nativeReadFile,
  writeFile as nativeWriteFile,
  editFile as nativeEditFile,
  listFiles as nativeListFiles,
  defaultPermissions as nativeDefaultPermissions,
} from '@codekalakaars/vajra-core'
import type { PermissionsConfig, ProjectFileEntry } from '@codekalakaars/vajra-protocol'

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

export function listFiles(path: string, includeHidden?: boolean): ProjectFileEntry[] {
  const entries = nativeListFiles(path, includeHidden)
  return entries.map(e => ({
    name: e.name,
    path: e.path,
    isDir: e.isDir,
    isMasked: false,
  }))
}

export function defaultPermissions(): PermissionsConfig {
  return nativeDefaultPermissions()
}
