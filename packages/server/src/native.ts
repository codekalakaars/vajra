// Single touch-point for vajra-core. Never re-export applySandbox —
// sandbox runs in the worker only.

import {
  scanProject as nativeScanProject,
  defaultPermissions as nativeDefaultPermissions,
  loadPermissions as nativeLoadPermissions,
  savePermissions as nativeSavePermissions,
  sandboxCapabilities as nativeSandboxCapabilities,
} from '@codekalakaars/vajra-core'
import type { PermissionsConfig, ProjectFileEntry } from '@vajra/protocol'

export function scanProject(projectDir: string): ProjectFileEntry[] {
  return nativeScanProject(projectDir)
}

export function defaultPermissions(): PermissionsConfig {
  return nativeDefaultPermissions()
}

export function loadPermissions(projectDir: string): PermissionsConfig | null {
  return nativeLoadPermissions(projectDir)
}

export function savePermissions(projectDir: string, config: PermissionsConfig): void {
  nativeSavePermissions(projectDir, config)
}

export function sandboxCapabilities() {
  return nativeSandboxCapabilities()
}
