import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import type { ProjectLoadPermissionsParams, ProjectSavePermissionsParams, ProjectScanParams } from '@vajra/protocol'
import { loadPermissions, defaultPermissions, savePermissions, scanProject } from '../../native.js'

export function registerProjectHandlers(router: RpcRouter<ServerContext>): void {
  router.register('project.loadPermissions', (params: ProjectLoadPermissionsParams) => {
    return loadPermissions(params.projectDir) ?? defaultPermissions()
  })

  router.register('project.savePermissions', (params: ProjectSavePermissionsParams) => {
    savePermissions(params.projectDir, params.config)
    return { ok: true as const }
  })

  router.register('project.scan', (params: ProjectScanParams) => {
    return scanProject(params.projectDir)
  })
}
