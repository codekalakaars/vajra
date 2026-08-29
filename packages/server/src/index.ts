import { createServer as createHttpServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { openDb } from './db/client.js'
import { createAppServer } from './ws/server.js'
import type { SessionLauncher } from './session/manager.js'
import { forkSessionLauncher } from './session/launcher.js'

// Load .env before reading process.env. Existing env vars win — dotenv never
// overrides by default. Try CWD first, then repo root (so `pnpm --filter`
// from packages/server still finds the root .env).
dotenv.config()
if (!process.env.OPENROUTER_API_KEY) {
  const repoRootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', '.env')
  dotenv.config({ path: repoRootEnv })
}

export interface StartOptions {
  port?: number
  dbPath?: string
  launcher?: SessionLauncher
  apiKey?: string
}

export interface RunningServer {
  port: number
  close(): Promise<void>
}

/**
 * Boots the HTTP+WebSocket server and opens the SQLite database. Returns a
 * handle rather than blocking, so tests can start a real server on an
 * ephemeral port and drive it with a real WS client.
 */
export function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const httpServer = createHttpServer()
  const db = openDb(options.dbPath ?? 'vajra.db')
  const { wss } = createAppServer(httpServer, { db, launcher: options.launcher, apiKey: options.apiKey })

  return new Promise((resolve) => {
    httpServer.listen(options.port ?? 0, () => {
      const address = httpServer.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0

      resolve({
        port,
        close: () =>
          new Promise((res) => {
            // http.Server#close's callback waits for every open connection to
            // finish, including already-upgraded WebSocket sockets — a client
            // that called ws.close() a moment ago may not have finished its
            // TCP teardown yet, and this would hang waiting for it. Terminate
            // any still-open clients first so close() always settles.
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
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is required (set in .env or environment)')
    console.error('  See .env.example at the repo root')
    process.exit(1)
  }
  startServer({ port, apiKey, launcher: forkSessionLauncher }).then((server) => {
    console.log(`vajra server listening on :${server.port}`)
  })
}
