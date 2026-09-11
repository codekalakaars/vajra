// Typed RPC caller over VajraSocket.

import type { VajraSocket } from './ws.js'

let nextId = 0

type RpcMethodMap = {
  'project.loadPermissions': { params: { projectDir: string }; result: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> }
  'project.savePermissions': { params: { projectDir: string; permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> }; result: { ok: true } }
  'project.scan': { params: { projectDir: string }; result: Array<{ name: string; path: string; isDir: boolean; isMasked: boolean }> }
  'session.list': { params: Record<string, never>; result: Array<{ sessionId: string; projectDir: string; task: string; status: string; createdAt: string }> }
  'session.create': { params: { projectDir: string; task: string; model?: string; permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>; allowUnenforced?: boolean }; result: { sessionId: string } }
  'session.attach': { params: { sessionId: string }; result: { session: Record<string, unknown>; plan: Array<unknown>; messages: Array<unknown> } }
  'session.stop': { params: { sessionId: string }; result: { ok: true } }
  'session.delete': { params: { sessionId: string }; result: { ok: true } }
  'session.sendMessage': { params: { sessionId: string; content: string }; result: { ok: true } }
}

export type MethodName = keyof RpcMethodMap

type PendingCall = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RpcClient {
  private socket: VajraSocket
  private pending = new Map<string, PendingCall>()
  private timeout = 30000

  constructor(socket: VajraSocket) {
    this.socket = socket
  }

  async call<M extends MethodName>(
    method: M,
    params: RpcMethodMap[M]['params']
  ): Promise<RpcMethodMap[M]['result']> {
    // Wait for WS to be connected before sending — avoids
    // "WebSocket is not connected" race when UI calls immediately
    // after page load or during reconnect. Reuses the same timeout.
    if (this.socket.state !== 'connected') {
      await new Promise<void>((resolve, reject) => {
        let unsub: (() => void) | null = null
        const timer = setTimeout(() => {
          if (unsub) unsub()
          reject(new Error('WebSocket is not connected'))
        }, this.timeout)
        unsub = this.socket.onStateChange((state) => {
          if (state === 'connected') {
            clearTimeout(timer)
            if (unsub) unsub()
            resolve()
          }
        })
        // Already connected between check and listener?
        if (this.socket.state === 'connected') {
          clearTimeout(timer)
          if (unsub) unsub()
          resolve()
        }
      })
    }

    const id = `rpc-${++nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC call ${method} timed out`))
      }, this.timeout)

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      })

      try {
        this.socket.send({ kind: 'rpc', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  handleResponse(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const msg = data as Record<string, unknown>
    if (msg.kind !== 'rpc-result') return

    const id = msg.id as string
    const pending = this.pending.get(id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(id)

    if (msg.ok) {
      pending.resolve(msg.result)
    } else {
      const errObj = msg.error as Record<string, unknown> | undefined
      const errMsg = errObj && typeof errObj === 'object' && typeof errObj.message === 'string'
        ? errObj.message
        : String(msg.error ?? 'RPC call failed')
      pending.reject(new Error(errMsg))
    }
  }
}
