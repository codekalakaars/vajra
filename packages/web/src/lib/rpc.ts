// Typed RPC caller over VajraSocket.

import type { VajraSocket } from './ws.js'

let nextId = 0

type RpcMethodMap = {
  'project.scan': { params: { projectDir: string }; result: Array<{ name: string; isDir: boolean; masked: boolean }> }
  'project.loadPermissions': { params: { projectDir: string }; result: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> }
  'project.savePermissions': { params: { projectDir: string; permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> }; result: { ok: true } }
  'session.list': { params: Record<string, never>; result: Array<{ sessionId: string; projectDir: string; task: string; status: string; createdAt: string }> }
  'session.create': { params: { projectDir: string; task: string; model?: string; permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>; allowUnenforced?: boolean }; result: { sessionId: string } }
  'session.attach': { params: { sessionId: string }; result: { session: Record<string, unknown>; plan: Array<unknown>; messages: Array<unknown> } }
  'session.stop': { params: { sessionId: string }; result: { ok: true } }
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

      this.socket.send({ kind: 'rpc', id, method, params })
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
      pending.reject(new Error(String(msg.error ?? 'RPC call failed')))
    }
  }
}
