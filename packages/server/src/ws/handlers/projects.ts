import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import type { ProjectLoadPermissionsParams, ProjectSavePermissionsParams, ProjectScanParams } from '@codekalakaars/vajra-protocol'
import { loadPermissions, defaultPermissions, savePermissions, scanProject } from '../../native.js'
import { readdir, stat } from 'fs/promises'
import { resolve, join, relative } from 'path'
import { homedir } from 'os'

const BROWSE_BASE_DIR = process.env.BROWSE_BASE_DIR ?? process.cwd()

interface BrowseEntry {
  name: string
  path: string
  isDir: boolean
}

interface ProjectBrowseParams {
  dir: string
}

async function browseDirectories(dir: string): Promise<BrowseEntry[]> {
  let target = dir.trim()
  if (!target) target = homedir()
  if (target === '~') target = homedir()
  if (target.startsWith('~/')) target = join(homedir(), target.slice(2))
  target = resolve(target)

  // Restrict browsing to the allowed base directory
  const rel = relative(BROWSE_BASE_DIR, target)
  if (rel.startsWith('..')) {
    throw new Error(`Directory "${dir}" is outside the allowed base directory`)
  }

  const entries: BrowseEntry[] = []
  try {
    const items = await readdir(target, { withFileTypes: true })
    for (const item of items) {
      if (!item.isDirectory()) continue
      if (item.name.startsWith('.') && item.name !== '..') continue
      entries.push({
        name: item.name,
        path: join(target, item.name),
        isDir: true,
      })
    }
  } catch {
    // If we can't read the directory, try to list its parent for suggestions
    const parent = resolve(target, '..')
    if (parent !== target) {
      // Also validate parent is within base dir
      const parentRel = relative(BROWSE_BASE_DIR, parent)
      if (!parentRel.startsWith('..')) {
        try {
          const items = await readdir(parent, { withFileTypes: true })
          for (const item of items) {
            if (!item.isDirectory()) continue
            if (item.name.startsWith('.') && item.name !== '..') continue
            entries.push({
              name: item.name,
              path: join(parent, item.name),
              isDir: true,
            })
          }
        } catch {
          // Return empty on failure
        }
      }
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

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

  router.register('project.browse', (params: ProjectBrowseParams) => {
    return browseDirectories(params.dir)
  })
}
