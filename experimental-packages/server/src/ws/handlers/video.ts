import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import type { ChildProcess } from 'child_process'
import { join, resolve, relative } from 'path'
import { readFile, writeFile, mkdir, access, readdir } from 'fs/promises'
import { componentLogger } from '../../logger.js'

const execFileAsync = promisify(execFile)

const log = componentLogger('video')

// Track preview server processes with their ports
const previewServers = new Map<string, { proc: ChildProcess, port: string }>()

interface VideoInitParams {
  projectDir: string
  template: string
  resolution?: string
  tailwind?: boolean
  /** Scaffold into a directory that already has files in it. */
  force?: boolean
}

interface VideoAddBlockParams {
  projectDir: string
  block: string
}

interface VideoRenderParams {
  projectDir: string
  output?: string
  quality?: string
  format?: string
  fps?: string
  strict?: boolean
}

interface VideoPreviewParams {
  projectDir: string
  port?: string
}

interface VideoListParams {
  type?: string
}

interface VideoReadFileParams {
  path: string
  projectDir: string
}

interface VideoWriteFileParams {
  path: string
  content: string
  projectDir: string
}

interface VideoStartPreviewParams {
  projectDir: string
  port?: string
}

interface VideoGetVariablesParams {
  projectDir: string
}

interface VideoSetVariableParams {
  projectDir: string
  key: string
  value: string
}

const REGISTRY_BASE =
  'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry'

/**
 * Validate that a file path is within the allowed directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 * Returns the resolved absolute path if valid, or throws if invalid.
 */
function validatePath(filePath: string, allowedDir: string): string {
  const resolved = resolve(allowedDir, filePath)
  const rel = relative(allowedDir, resolved)
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`Path "${filePath}" is outside the allowed directory "${allowedDir}"`)
  }
  return resolved
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const VIDEO_PROJECTS_BASE = process.env.VIDEO_PROJECTS_BASE ?? process.cwd()

/**
 * Validate that a project directory is within the allowed base directory.
 * Prevents path traversal via projectDir parameters.
 */
function validateProjectDir(projectDir: string): string {
  const resolved = resolve(projectDir)
  const rel = relative(VIDEO_PROJECTS_BASE, resolved)
  if (rel.startsWith('..')) {
    throw new Error(`Project directory "${projectDir}" is outside the allowed base directory`)
  }
  return resolved
}

export function registerVideoHandlers(router: RpcRouter<ServerContext>): void {
  router.register('video.init', async (params: VideoInitParams) => {
    const { projectDir, template, resolution = 'landscape', tailwind = false, force = false } = params

    if (!projectDir || !template) {
      return { success: false, error: 'projectDir and template are required' }
    }

    let safeDir: string
    try {
      safeDir = validatePath(projectDir, VIDEO_PROJECTS_BASE)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    try {
      // This used to `rm -rf` whatever was already there. Confinement to the
      // base directory is not consent: any existing directory under it — a
      // source tree, someone else's project — was silently destroyed by a
      // caller that only meant to scaffold. Refuse instead, and make the
      // destructive path explicit.
      let existing: string[] | null = null
      try {
        await access(safeDir)
        existing = await readdir(safeDir)
      } catch {
        // Directory doesn't exist, which is fine
      }

      if (existing !== null && existing.length > 0 && !force) {
        return {
          success: false,
          error: `Directory "${projectDir}" already exists and is not empty. Choose another path, or pass force: true to scaffold into it.`,
        }
      }

      const args = [
        'hyperframes', 'init', safeDir,
        '--example', template,
        '--non-interactive',
        '--resolution', resolution,
      ]

      if (tailwind) {
        args.push('--tailwind')
      }

      await execFileAsync('npx', args)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to initialize video project' }
    }
  })

  router.register('video.addBlock', async (params: VideoAddBlockParams) => {
    const { projectDir, block } = params

    if (!projectDir || !block) {
      return { success: false, error: 'projectDir and block are required' }
    }

    let safeDir: string
    try {
      safeDir = validateProjectDir(projectDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    try {
      await execFileAsync('npx', ['hyperframes', 'add', block, '--dir', safeDir, '--no-clipboard'])
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add block' }
    }
  })

  router.register('video.render', async (params: VideoRenderParams) => {
    const { projectDir, output, quality = 'standard', format = 'mp4', fps = '30', strict = false } = params

    if (!projectDir) {
      return { success: false, error: 'projectDir is required' }
    }

    let safeDir: string
    try {
      safeDir = validateProjectDir(projectDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    try {
      const args = ['hyperframes', 'render', safeDir]

      if (output) args.push('--output', output)
      if (quality) args.push('--quality', quality)
      if (format) args.push('--format', format)
      if (fps) args.push('--fps', fps)
      if (strict) args.push('--strict')

      const { stdout } = await execFileAsync('npx', args)
      return { success: true, output: stdout }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to render video' }
    }
  })

  router.register('video.preview', async (params: VideoPreviewParams) => {
    const { projectDir, port = '3002' } = params

    if (!projectDir) {
      return { success: false, error: 'projectDir is required' }
    }

    let safeDir: string
    try {
      safeDir = validateProjectDir(projectDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    try {
      await execFileAsync('npx', ['hyperframes', 'preview', safeDir, '--port', port])
      return { success: true, port }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to start preview' }
    }
  })

  router.register('video.list', async (params: VideoListParams) => {
    try {
      const response = await fetch(`${REGISTRY_BASE}/registry.json`)
      if (!response.ok) {
        throw new Error(`Registry fetch failed: ${response.status} ${response.statusText}`)
      }
      const data = (await response.json()) as { items: Array<{ name: string; type: string }> }

      let items = data.items

      if (params.type) {
        items = items.filter(i => i.type === `hyperframes:${params.type}`)
      }

      return {
        success: true,
        items: items.map(i => ({
          name: i.name,
          type: i.type.replace('hyperframes:', ''),
        })),
      }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to fetch registry' }
    }
  })

  router.register('video.readFile', async (params: VideoReadFileParams) => {
    const { path: filePath, projectDir } = params

    if (!filePath || !projectDir) {
      return { success: false, error: 'path and projectDir are required' }
    }

    try {
      const safeDir = validateProjectDir(projectDir)
      const safePath = validatePath(filePath, safeDir)
      const content = await readFile(safePath, 'utf-8')
      return { success: true, content }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to read file' }
    }
  })

  router.register('video.writeFile', async (params: VideoWriteFileParams) => {
    const { path: filePath, content, projectDir } = params

    if (!filePath || content === undefined || !projectDir) {
      return { success: false, error: 'path, content, and projectDir are required' }
    }

    try {
      const safeDir = validateProjectDir(projectDir)
      const safePath = validatePath(filePath, safeDir)
      // Ensure directory exists
      const dir = join(safePath, '..')
      await mkdir(dir, { recursive: true })
      await writeFile(safePath, content, 'utf-8')
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to write file' }
    }
  })

  router.register('video.startPreview', (params: VideoStartPreviewParams) => {
    const { projectDir, port = '3002' } = params

    if (!projectDir) {
      return { success: false, error: 'projectDir is required' }
    }

    let safeDir: string
    try {
      safeDir = validateProjectDir(projectDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    // Stop existing preview if running
    const existing = previewServers.get(safeDir)
    if (existing) {
      existing.proc.kill()
      previewServers.delete(safeDir)
    }

    try {
      const proc = spawn('npx', ['hyperframes', 'preview', safeDir, '--port', port], {
        stdio: 'pipe',
      })

      previewServers.set(safeDir, { proc, port })

      proc.on('error', (err: Error) => {
        log.error({ projectDir: safeDir, error: err }, 'Preview server error')
        previewServers.delete(safeDir)
      })

      proc.on('exit', () => {
        previewServers.delete(safeDir)
      })

      return { success: true, port, url: `http://localhost:${port}` }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to start preview' }
    }
  })

  router.register('video.stopPreview', (params: { projectDir: string }) => {
    const { projectDir } = params
    const entry = previewServers.get(projectDir)
    if (entry) {
      entry.proc.kill()
      previewServers.delete(projectDir)
      return { success: true }
    }
    return { success: true, message: 'No preview running' }
  })

  router.register('video.getPreviewStatus', (params: { projectDir: string }) => {
    const { projectDir } = params
    const entry = previewServers.get(projectDir)
    return {
      success: true,
      running: !!entry,
      port: entry?.port ?? '3002',
      url: entry ? `http://localhost:${entry.port}` : null,
    }
  })

  router.register('video.getVariables', async (params: VideoGetVariablesParams) => {
    const { projectDir } = params
    // Validate projectDir is within allowed base
    let safeDir: string
    try {
      safeDir = validateProjectDir(projectDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }
    let varsPath: string
    try {
      varsPath = validatePath('composition-variables.json', safeDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    try {
      try {
        await access(varsPath)
        const content = await readFile(varsPath, 'utf-8')
        const variables = JSON.parse(content)
        return { success: true, variables }
      } catch {
        return { success: true, variables: {} }
      }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to read variables' }
    }
  })

  router.register('video.setVariable', async (params: VideoSetVariableParams) => {
    const { projectDir, key, value } = params
    let safeDir: string
    try {
      safeDir = validateProjectDir(projectDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }
    let varsPath: string
    try {
      varsPath = validatePath('composition-variables.json', safeDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    if (FORBIDDEN_KEYS.has(key)) {
      return { success: false, error: `Key "${key}" is not allowed` }
    }

    try {
      let variables: Record<string, string> = {}
      try {
        await access(varsPath)
        const content = await readFile(varsPath, 'utf-8')
        variables = JSON.parse(content)
      } catch {
        // File doesn't exist yet, start with empty object
      }

      variables[key] = value
      await writeFile(varsPath, JSON.stringify(variables, null, 2), 'utf-8')
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to set variable' }
    }
  })

  router.register('video.deleteVariable', async (params: { projectDir: string; key: string }) => {
    const { projectDir, key } = params
    let safeDir: string
    try {
      safeDir = validateProjectDir(projectDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }
    let varsPath: string
    try {
      varsPath = validatePath('composition-variables.json', safeDir)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    if (FORBIDDEN_KEYS.has(key)) {
      return { success: false, error: `Key "${key}" is not allowed` }
    }

    try {
      try {
        await access(varsPath)
        const content = await readFile(varsPath, 'utf-8')
        const variables = JSON.parse(content)
        delete variables[key]
        await writeFile(varsPath, JSON.stringify(variables, null, 2), 'utf-8')
      } catch {
        // File doesn't exist, nothing to delete
      }
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete variable' }
    }
  })
}

/**
 * Kill all preview server processes. Called during server shutdown.
 */
export function killAllPreviewServers(): void {
  for (const [, entry] of previewServers) {
    entry.proc.kill()
  }
  previewServers.clear()
}
