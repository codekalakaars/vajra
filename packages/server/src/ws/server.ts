import { WebSocketServer, type WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { ClientMessage, PushEvent } from '@codekalakaars/vajra-protocol'
import type { SqliteDb } from '../db/client.js'
import { ProjectManager, notImplementedLauncher, type ProjectLauncher } from '../project/manager.js'
import { RpcRouter } from './rpc.js'
import { registerProjectHandlers } from './handlers/projects.js'
import { registerSessionHandlers } from './handlers/projects-handler.js'
import { registerVideoHandlers } from './handlers/video.js'
import { componentLogger } from '../logger.js'

const log = componentLogger('ws')

// Rate limiting config
const RATE_LIMIT_MAX_MESSAGES = 100
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute

// Authentication config
const AUTH_TOKEN = process.env.VAJRA_AUTH_TOKEN

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Validate the authentication token from the WebSocket request.
 * Returns true if authentication is successful or not required.
 */
function authenticate(req: IncomingMessage): boolean {
  // If no auth token is configured, allow all connections
  if (!AUTH_TOKEN) return true

  // Check Authorization header: "Bearer <token>"
  const authHeader = req.headers.authorization
  if (authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
    return safeEqual(token, AUTH_TOKEN)
  }

  // Check query parameter: ?token=<token>
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const token = url.searchParams.get('token')
  if (token) {
    return safeEqual(token, AUTH_TOKEN)
  }

  return false
}

class ClientConnection {
  private subscriptions = new Set<string>()
  private messageCount = 0
  private windowStart = Date.now()

  constructor(
    private ws: WebSocket,
    private registry: Map<string, Set<ClientConnection>>,
  ) {}

  subscribe(projectId: string): void {
    this.subscriptions.add(projectId)
    let set = this.registry.get(projectId)
    if (!set) {
      set = new Set()
      this.registry.set(projectId, set)
    }
    set.add(this)
  }

  send(message: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  /**
   * Check if the client has exceeded the rate limit.
   * Returns true if the message should be rejected.
   */
  checkRateLimit(): boolean {
    const now = Date.now()
    if (now - this.windowStart > RATE_LIMIT_WINDOW_MS) {
      // Reset window
      this.messageCount = 0
      this.windowStart = now
    }
    this.messageCount++
    return this.messageCount > RATE_LIMIT_MAX_MESSAGES
  }

  cleanup(): void {
    for (const projectId of this.subscriptions) {
      const set = this.registry.get(projectId)
      set?.delete(this)
      if (set && set.size === 0) {
        this.registry.delete(projectId)
      }
    }
  }
}

export interface ServerContext {
  db: SqliteDb
  projects: ProjectManager
  connection: ClientConnection
  apiKeys: Record<string, string>
}

export interface CreateAppServerOptions {
  db: SqliteDb
  launcher?: ProjectLauncher
  apiKeys?: Record<string, string>
}

export function createAppServer(httpServer: HttpServer, options: CreateAppServerOptions) {
  const subscribers = new Map<string, Set<ClientConnection>>()

  const events = {
    push(event: string, projectId: string, payload: unknown): void {
      const message: PushEvent = { kind: 'event', event, sessionId: projectId, payload }
      for (const conn of subscribers.get(projectId) ?? []) {
        conn.send(message)
      }
    },
  }

  const projects = new ProjectManager(options.db, options.launcher ?? notImplementedLauncher, events)

  const router = new RpcRouter<ServerContext>()
  registerProjectHandlers(router)
  registerSessionHandlers(router)
  registerVideoHandlers(router)

  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    // Check authentication
    if (!authenticate(req)) {
      log.warn('WebSocket connection rejected: invalid or missing auth token')
      ws.close(4001, 'Unauthorized')
      return
    }

    const connection = new ClientConnection(ws, subscribers)

    ws.on('message', async (raw) => {
      let request: ClientMessage
      try {
        request = JSON.parse(raw.toString())
      } catch {
        return // malformed frame — ignore rather than crash the connection
      }
      if (request.kind !== 'rpc') return

      // Rate limit check (after parsing so we can return the correct request ID)
      if (connection.checkRateLimit()) {
        log.warn('Client exceeded rate limit')
        connection.send({
          kind: 'rpc-result',
          id: request.id,
          ok: false,
          error: { message: 'Rate limit exceeded. Please slow down.', code: 'RATE_LIMITED' },
        })
        return
      }

      const ctx: ServerContext = { db: options.db, projects, connection, apiKeys: options.apiKeys ?? {} }
      const response = await router.dispatch(request, ctx)
      connection.send(response)
    })

    ws.on('close', () => connection.cleanup())
  })

  return { wss, projects }
}
