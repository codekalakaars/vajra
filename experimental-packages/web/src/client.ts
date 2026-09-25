// High-level client combining socket, RPC, and event bus.

import { VajraSocket, type ConnectionState } from './lib/ws.js'
import { RpcClient, type MethodName, type RpcMethodMap } from './lib/rpc.js'
import { EventBus, type EventName } from './lib/events.js'

export class VajraClient {
  private socket: VajraSocket
  private rpc: RpcClient
  private events: EventBus
  private stateListeners = new Set<(state: ConnectionState) => void>()

  constructor(url: string) {
    this.socket = new VajraSocket(url)
    this.rpc = new RpcClient(this.socket)
    this.events = new EventBus()

    this.socket.onMessage((data) => {
      this.rpc.handleResponse(data)

      if (data && typeof data === 'object') {
        const msg = data as Record<string, unknown>
        if (msg.kind === 'event' && typeof msg.event === 'string') {
          const payload = (typeof msg.payload === 'object' && msg.payload !== null)
            ? { ...msg.payload as Record<string, unknown>, projectId: msg.sessionId }
            : { projectId: msg.sessionId }
          this.events.emit(msg.event, payload)
        }
      }
    })

    this.socket.onStateChange((state) => {
      for (const handler of this.stateListeners) {
        handler(state)
      }
    })
  }

  connect(): void {
    this.socket.connect()
  }

  disconnect(): void {
    this.socket.disconnect()
  }

  get state(): ConnectionState {
    return this.socket.state
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(handler)
    return () => this.stateListeners.delete(handler)
  }

  async call<M extends MethodName>(
    method: M,
    params: RpcMethodMap[M]['params']
  ): Promise<RpcMethodMap[M]['result']> {
    return this.rpc.call(method, params)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on<E extends EventName>(event: E, handler: (payload: any) => void): () => void {
    return this.events.on(event, handler)
  }
}
