import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import { execFileSync } from 'child_process'
import { join, resolve, relative } from 'path'
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

// Track preview server processes
const previewServers = new Map<string, ChildProcess>()

interface VideoInitParams {
  projectDir: string
  template: string
  resolution?: string
  tailwind?: boolean
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

export function registerVideoHandlers(router: RpcRouter<ServerContext>): void {
  router.register('video.init', (params: VideoInitParams) => {
    const { projectDir, template, resolution = 'landscape', tailwind = false } = params

    console.log('[video.init] called with:', { projectDir, template, resolution, tailwind })

    if (!projectDir || !template) {
      return { success: false, error: 'projectDir and template are required' }
    }

    try {
      // Remove directory if it exists
      if (existsSync(projectDir)) {
        rmSync(projectDir, { recursive: true, force: true })
      }

      const args = [
        'npx', 'hyperframes', 'init', projectDir,
        '--example', template,
        '--non-interactive',
        '--resolution', resolution,
      ]

      if (tailwind) {
        args.push('--tailwind')
      }

      execSync(args.join(' '), { stdio: 'pipe' })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to initialize video project' }
    }
  })

  router.register('video.addBlock', (params: VideoAddBlockParams) => {
    const { projectDir, block } = params

    if (!projectDir || !block) {
      return { success: false, error: 'projectDir and block are required' }
    }

    try {
      execSync(`npx hyperframes add ${block} --dir ${projectDir} --no-clipboard`, {
        stdio: 'pipe',
      })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to add block' }
    }
  })

  router.register('video.render', (params: VideoRenderParams) => {
    const { projectDir, output, quality = 'standard', format = 'mp4', fps = '30', strict = false } = params

    if (!projectDir) {
      return { success: false, error: 'projectDir is required' }
    }

    try {
      const args = ['npx', 'hyperframes', 'render', projectDir]

      if (output) args.push('--output', output)
      if (quality) args.push('--quality', quality)
      if (format) args.push('--format', format)
      if (fps) args.push('--fps', fps)
      if (strict) args.push('--strict')

      const outputBuffer = execSync(args.join(' '), { stdio: 'pipe' })
      return { success: true, output: outputBuffer.toString() }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to render video' }
    }
  })

  router.register('video.preview', (params: VideoPreviewParams) => {
    const { projectDir, port = '3002' } = params

    if (!projectDir) {
      return { success: false, error: 'projectDir is required' }
    }

    try {
      execSync(`npx hyperframes preview ${projectDir} --port ${port}`, {
        stdio: 'pipe',
      })
      return { success: true, port }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to start preview' }
    }
  })

  router.register('video.list', async (params: VideoListParams) => {
    try {
      const response = await fetch(`${REGISTRY_BASE}/registry.json`)
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

  router.register('video.readFile', (params: VideoReadFileParams) => {
    const { path: filePath, projectDir } = params

    if (!filePath || !projectDir) {
      return { success: false, error: 'path and projectDir are required' }
    }

    try {
      const safePath = validatePath(filePath, projectDir)
      const content = readFileSync(safePath, 'utf-8')
      return { success: true, content }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to read file' }
    }
  })

  router.register('video.writeFile', (params: VideoWriteFileParams) => {
    const { path: filePath, content, projectDir } = params

    if (!filePath || content === undefined || !projectDir) {
      return { success: false, error: 'path, content, and projectDir are required' }
    }

    try {
      const safePath = validatePath(filePath, projectDir)
      // Ensure directory exists
      const dir = join(safePath, '..')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(safePath, content, 'utf-8')
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

    // Stop existing preview if running
    const existing = previewServers.get(projectDir)
    if (existing) {
      existing.kill()
      previewServers.delete(projectDir)
    }

    try {
      const proc = spawn('npx', ['hyperframes', 'preview', projectDir, '--port', port], {
        stdio: 'pipe',
        detached: true,
      })

      previewServers.set(projectDir, proc)

      proc.on('error', (err) => {
        console.error(`Preview server error for ${projectDir}:`, err)
        previewServers.delete(projectDir)
      })

      proc.on('exit', () => {
        previewServers.delete(projectDir)
      })

      return { success: true, port, url: `http://localhost:${port}` }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to start preview' }
    }
  })

  router.register('video.stopPreview', (params: { projectDir: string }) => {
    const { projectDir } = params
    const proc = previewServers.get(projectDir)
    if (proc) {
      proc.kill()
      previewServers.delete(projectDir)
      return { success: true }
    }
    return { success: true, message: 'No preview running' }
  })

  router.register('video.getPreviewStatus', (params: { projectDir: string }) => {
    const { projectDir } = params
    const proc = previewServers.get(projectDir)
    return {
      success: true,
      running: !!proc,
      port: '3002',
      url: proc ? `http://localhost:3002` : null,
    }
  })
}
