import { WebSocketServer, type WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import type { ClientMessage, PushEvent, PushEventName, PushEventPayloads } from '@codekalakaars/vajra-protocol'
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
const MAX_CONCURRENT_PROJECTS = 3
const MAX_TOTAL_AGENT_RUNS = 10

// Backpressure config
const BACKPRESSURE_HIGH_WATER = 1024 * 1024 // 1 MiB buffered before dropping
const BACKPRESSURE_DISCONNECT = 4 * 1024 * 1024 // 4 MiB before disconnecting slow client

// Authentication — generate a token when none is provided so the server is
// never accidentally exposed without auth.
let AUTH_TOKEN = process.env.VAJRA_AUTH_TOKEN
if (!AUTH_TOKEN) {
  AUTH_TOKEN = randomBytes(32).toString('hex')
  log.warn({ token: AUTH_TOKEN }, 'No VAJRA_AUTH_TOKEN set — generated a temporary token for this session')
}

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
 * Returns true if authentication is successful.
 */
function authenticate(req: IncomingMessage): boolean {
  // Check Authorization header: "Bearer <token>"
  const authHeader = req.headers.authorization
  if (authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
    return safeEqual(token, AUTH_TOKEN!)
  }

  // Check query parameter: ?token=<token>
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const token = url.searchParams.get('token')
  if (token) {
    return safeEqual(token, AUTH_TOKEN!)
  }

  return false
}

class ClientConnection {
  private subscriptions = new Set<string>()
  private messageCount = 0
  private windowStart = Date.now()
  private activeProjects = 0

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
    this.activeProjects++
  }

  unsubscribe(projectId: string): void {
    if (this.subscriptions.delete(projectId)) {
      this.activeProjects = Math.max(0, this.activeProjects - 1)
    }
    const set = this.registry.get(projectId)
    set?.delete(this)
    if (set && set.size === 0) {
      this.registry.delete(projectId)
    }
  }

  send(message: unknown): boolean {
    if (this.ws.readyState !== this.ws.OPEN) return false

    // Backpressure: check buffered bytes before sending
    if (this.ws.bufferedAmount > BACKPRESSURE_DISCONNECT) {
      log.warn('Disconnecting slow client — buffer exceeds disconnect threshold')
      this.ws.close(4002, 'Too slow')
      return false
    }
    if (this.ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
      // Drop non-critical messages when buffer is filling up
      const msg = message as { kind?: string; event?: string }
      if (msg.kind === 'event' && msg.event !== 'projects.statusChanged') {
        return false
      }
    }

    this.ws.send(JSON.stringify(message))
    return true
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

  /**
   * Check if the client has exceeded the concurrent project limit.
   * Returns true if the request should be rejected.
   */
  checkProjectLimit(): boolean {
    return this.activeProjects >= MAX_CONCURRENT_PROJECTS
  }

  cleanup(): void {
    for (const projectId of this.subscriptions) {
      const set = this.registry.get(projectId)
      set?.delete(this)
      if (set && set.size === 0) {
        this.registry.delete(projectId)
      }
    }
    this.subscriptions.clear()
    this.activeProjects = 0
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
  let totalAgentRuns = 0

  const events = {
    push<E extends PushEventName>(event: E, projectId: string, payload: PushEventPayloads[E]): void {
      const message: PushEvent<E> = { kind: 'event', event, sessionId: projectId, payload }
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

      // Concurrent project limit — bound expensive work, not just messages
      if (request.method === 'projects.create' && connection.checkProjectLimit()) {
        log.warn('Client exceeded concurrent project limit')
        connection.send({
          kind: 'rpc-result',
          id: request.id,
          ok: false,
          error: { message: `Concurrent project limit (${MAX_CONCURRENT_PROJECTS}) exceeded.`, code: 'PROJECT_LIMITED' },
        })
        return
      }

      // Global agent run cap
      if (request.method === 'projects.create' && totalAgentRuns >= MAX_TOTAL_AGENT_RUNS) {
        log.warn('Global agent run limit reached')
        connection.send({
          kind: 'rpc-result',
          id: request.id,
          ok: false,
          error: { message: `Server agent capacity full (${MAX_TOTAL_AGENT_RUNS} runs). Try again later.`, code: 'CAPACITY_FULL' },
        })
        return
      }

      const ctx: ServerContext = { db: options.db, projects, connection, apiKeys: options.apiKeys ?? {} }
      const response = await router.dispatch(request, ctx)
      connection.send(response)
    })

    ws.on('close', () => connection.cleanup())
  })

  return {
    wss,
    projects,
    /** Increment when an agent run starts; returns the new count. */
    trackAgentRun() { return ++totalAgentRuns },
    /** Decrement when an agent run ends. */
    releaseAgentRun() { totalAgentRuns = Math.max(0, totalAgentRuns - 1) },
  }
}
