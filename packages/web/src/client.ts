// High-level client combining socket, RPC, and event bus.

import { VajraSocket, type ConnectionState } from './lib/ws.js'
import { RpcClient, type MethodName } from './lib/rpc.js'
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
          this.events.emit(msg.event, msg.payload)
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
    params: Extract<{ [K in M]: unknown }, M> extends { params: infer P } ? P : never
  ): Promise<unknown> {
    return this.rpc.call(method, params as never)
  }

  on<E extends EventName>(event: E, handler: (payload: unknown) => void): () => void {
    return this.events.on(event, handler as (payload: never) => void)
  }
}
