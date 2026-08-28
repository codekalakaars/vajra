import { WebSocketServer, type WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type { ClientMessage, PushEvent } from '@vajra/protocol'
import type { SqliteDb } from '../db/client.js'
import { SessionManager, notImplementedLauncher, type SessionLauncher } from '../session/manager.js'
import { RpcRouter } from './rpc.js'
import { registerProjectHandlers } from './handlers/projects.js'
import { registerSessionHandlers } from './handlers/sessions.js'

class ClientConnection {
  private subscriptions = new Set<string>()

  constructor(
    private ws: WebSocket,
    private registry: Map<string, Set<ClientConnection>>,
  ) {}

  subscribe(sessionId: string): void {
    this.subscriptions.add(sessionId)
    let set = this.registry.get(sessionId)
    if (!set) {
      set = new Set()
      this.registry.set(sessionId, set)
    }
    set.add(this)
  }

  send(message: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  cleanup(): void {
    for (const sessionId of this.subscriptions) {
      this.registry.get(sessionId)?.delete(this)
    }
  }
}

export interface ServerContext {
  db: SqliteDb
  sessions: SessionManager
  connection: ClientConnection
  apiKey: string
}

export interface CreateAppServerOptions {
  db: SqliteDb
  launcher?: SessionLauncher
  apiKey?: string
}

export function createAppServer(httpServer: HttpServer, options: CreateAppServerOptions) {
  const subscribers = new Map<string, Set<ClientConnection>>()

  const events = {
    push(event: string, sessionId: string, payload: unknown): void {
      const message: PushEvent = { kind: 'event', event, sessionId, payload }
      for (const conn of subscribers.get(sessionId) ?? []) {
        conn.send(message)
      }
    },
  }

  const sessions = new SessionManager(options.db, options.launcher ?? notImplementedLauncher, events)

  const router = new RpcRouter<ServerContext>()
  registerProjectHandlers(router)
  registerSessionHandlers(router)

  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws) => {
    const connection = new ClientConnection(ws, subscribers)

    ws.on('message', async (raw) => {
      let request: ClientMessage
      try {
        request = JSON.parse(raw.toString())
      } catch {
        return // malformed frame — ignore rather than crash the connection
      }
      if (request.kind !== 'rpc') return

      const ctx: ServerContext = { db: options.db, sessions, connection, apiKey: options.apiKey ?? '' }
      const response = await router.dispatch(request, ctx)
      connection.send(response)
    })

    ws.on('close', () => connection.cleanup())
  })

  return { wss, sessions }
}
