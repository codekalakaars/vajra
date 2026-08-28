import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import type {
  ProjectScanParams,
  ProjectLoadPermissionsParams,
  ProjectSavePermissionsParams,
} from '@vajra/protocol'
import { scanProject, loadPermissions, defaultPermissions, savePermissions } from '../../native.js'

export function registerProjectHandlers(router: RpcRouter<ServerContext>): void {
  router.register('project.scan', (params: ProjectScanParams) => scanProject(params.projectDir))

  router.register('project.loadPermissions', (params: ProjectLoadPermissionsParams) => {
    return loadPermissions(params.projectDir) ?? defaultPermissions()
  })

  router.register('project.savePermissions', (params: ProjectSavePermissionsParams) => {
    savePermissions(params.projectDir, params.config)
    return { ok: true as const }
  })
}
