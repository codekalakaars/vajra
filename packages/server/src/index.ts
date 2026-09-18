import { createServer as createHttpServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { openDb } from './db/client.js'
import { createAppServer } from './ws/server.js'
import type { ProjectLauncher } from './project/manager.js'
import { forkProjectLauncher } from './project/launcher.js'
import { componentLogger } from './logger.js'
import { killAllPreviewServers } from './ws/handlers/video.js'

const log = componentLogger('server')

dotenv.config()
if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.OPENCODE_API_KEY) {
  const repoRootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', '.env')
  dotenv.config({ path: repoRootEnv })
}

export interface StartOptions {
  port?: number
  /** Interface to bind. Defaults to loopback. */
  host?: string
  dbPath?: string
  launcher?: ProjectLauncher
  apiKeys?: Record<string, string>
}

/** Binding anywhere else exposes the RPC surface to the network. */
const DEFAULT_HOST = '127.0.0.1'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export interface RunningServer {
  port: number
  close(): Promise<void>
}

export function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const host = options.host ?? process.env.VAJRA_HOST ?? DEFAULT_HOST

  // Authentication is opt-in, so an unset token on a public interface hands
  // every RPC method — including the ones that write files and spawn
  // processes — to anyone who can reach the port.
  if (!LOOPBACK_HOSTS.has(host) && !process.env.VAJRA_AUTH_TOKEN) {
    return Promise.reject(
      new Error(
        `Refusing to listen on ${host} without VAJRA_AUTH_TOKEN. ` +
        'Set a token, or bind loopback (unset VAJRA_HOST).',
      ),
    )
  }

  const httpServer = createHttpServer()
  const db = openDb(options.dbPath ?? 'vajra.db')
  const { wss } = createAppServer(httpServer, { db, launcher: options.launcher, apiKeys: options.apiKeys })

  return new Promise((resolve) => {
    httpServer.listen(options.port ?? 0, host, () => {
      const address = httpServer.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0

      resolve({
        port,
        close: () =>
          new Promise((res) => {
            for (const client of wss.clients) client.terminate()

            wss.close(() => {
              httpServer.close(() => {
                db.close()
                res()
              })
            })
          }),
      })
    })
  })
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const port = Number(process.env.PORT) || 4820
  const apiKeys: Record<string, string> = {}
  if (process.env.OPENROUTER_API_KEY) apiKeys.openrouter = process.env.OPENROUTER_API_KEY
  if (process.env.ANTHROPIC_API_KEY) apiKeys.anthropic = process.env.ANTHROPIC_API_KEY
  if (process.env.OPENCODE_API_KEY) apiKeys.zen = process.env.OPENCODE_API_KEY
  if (Object.keys(apiKeys).length === 0) {
    log.error('API key required: set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENCODE_API_KEY in .env or environment')
    log.error('  See .env.example at the repo root')
    process.exit(1)
  }
  startServer({ port, apiKeys, launcher: forkProjectLauncher }).then((server) => {
    log.info({ port, host: process.env.VAJRA_HOST ?? DEFAULT_HOST }, 'vajra server listening')

    // Graceful shutdown on SIGTERM/SIGINT
    const shutdown = async (signal: string) => {
      log.info({ signal }, 'Received shutdown signal, closing server...')
      try {
        killAllPreviewServers()
        await server.close()
        log.info('Server closed gracefully')
        process.exit(0)
      } catch (err) {
        log.error({ error: err }, 'Error during shutdown')
        process.exit(1)
      }
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  }).catch((err) => {
    log.error({ error: err instanceof Error ? err.message : err }, 'Failed to start server')
    process.exit(1)
  })
}
