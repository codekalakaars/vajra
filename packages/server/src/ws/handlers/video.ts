import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import { execSync } from 'child_process'
import { join } from 'path'
import { rmSync, existsSync } from 'fs'

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

const REGISTRY_BASE =
  'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry'

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
}
