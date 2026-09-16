import { WebSocketServer, type WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type { ClientMessage, PushEvent } from '@codekalakaars/vajra-protocol'
import type { SqliteDb } from '../db/client.js'
import { ProjectManager, notImplementedLauncher, type ProjectLauncher } from '../project/manager.js'
import { RpcRouter } from './rpc.js'
import { registerProjectHandlers } from './handlers/projects.js'
import { registerProjectHandlers as registerSessionHandlers } from './handlers/projects-handler.js'
import { registerVideoHandlers } from './handlers/video.js'

class ClientConnection {
  private subscriptions = new Set<string>()

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

  cleanup(): void {
    for (const projectId of this.subscriptions) {
      this.registry.get(projectId)?.delete(this)
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

      const ctx: ServerContext = { db: options.db, projects, connection, apiKeys: options.apiKeys ?? {} }
      const response = await router.dispatch(request, ctx)
      connection.send(response)
    })

    ws.on('close', () => connection.cleanup())
  })

  return { wss, projects }
}
