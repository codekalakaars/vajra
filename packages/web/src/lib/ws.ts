// Low-level WebSocket wrapper with reconnection support.

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

type MessageHandler = (data: unknown) => void
type StateHandler = (state: ConnectionState) => void

export class VajraSocket {
  private ws: WebSocket | null = null
  private url: string
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxDelay = 30000
  private messageHandlers = new Set<MessageHandler>()
  private stateHandlers = new Set<StateHandler>()
  private _state: ConnectionState = 'disconnected'

  constructor(url: string) {
    this.url = url
  }

  get state(): ConnectionState {
    return this._state
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return

    this.setState('connecting')
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this.setState('connected')
      this.reconnectDelay = 1000
    }

    this.ws.onmessage = (event) => {
      let data: unknown
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      for (const handler of this.messageHandlers) {
        handler(data)
      }
    }

    this.ws.onclose = () => {
      this.setState('disconnected')
      this.ws = null
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.setState('disconnected')
  }

  send(data: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected')
    }
    this.ws.send(JSON.stringify(data))
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return
    this._state = state
    for (const handler of this.stateHandlers) {
      handler(state)
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay)
  }
}
