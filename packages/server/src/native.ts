// The single place this package touches `vajra-native` — and deliberately
// does NOT re-export `applySandbox`.
//
// Security invariant: the main server process must never confine itself.
// `applySandbox` is called from exactly one file in this package's tree —
// `worker/sandboxed-worker.mjs` — which requires `vajra-native` on its own,
// independently of this module. Nothing here should ever import it; if a
// future change needs it in this file, that is the invariant breaking, not
// a refactor to wave through.
//
// Return types are annotated with @vajra/protocol's hand-mirrored shapes
// rather than cast — TypeScript's structural typing checks the two agree,
// so this is real verification, not decoration. If vajra-native's shape ever
// drifts from the mirrored one, this file fails to compile rather than
// silently passing a mismatched value through.
import {
  scanProject as nativeScanProject,
  defaultPermissions as nativeDefaultPermissions,
  loadPermissions as nativeLoadPermissions,
  savePermissions as nativeSavePermissions,
  sandboxCapabilities as nativeSandboxCapabilities,
} from 'vajra-native'
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
