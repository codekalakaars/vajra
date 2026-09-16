// Typed RPC caller over VajraSocket.

import type { VajraSocket } from './ws.js'
import type { PermissionsConfig } from '@codekalakaars/vajra-protocol'

let nextId = 0

export type RpcMethodMap = {
  'project.loadPermissions': { params: { projectDir: string }; result: PermissionsConfig }
  'project.savePermissions': { params: { projectDir: string; config: PermissionsConfig }; result: { ok: true } }
  'project.scan': { params: { projectDir: string }; result: Array<{ name: string; path: string; isDir: boolean; isMasked: boolean }> }
  'project.browse': { params: { dir: string }; result: Array<{ name: string; path: string; isDir: boolean }> }
  'projects.list': { params: Record<string, never>; result: Array<{ id: string; projectDir: string; task: string; model: string; status: string; createdAt: number }> }
  'projects.create': { params: { projectDir: string; task: string; model: string; permissions: PermissionsConfig; allowUnenforced?: boolean }; result: { projectId: string } }
  'projects.attach': { params: { projectId: string }; result: { project: Record<string, unknown>; plan: Array<unknown>; messages: Array<unknown> } }
  'projects.stop': { params: { projectId: string }; result: { ok: true } }
  'projects.delete': { params: { projectId: string }; result: { ok: true } }
  'projects.sendMessage': { params: { projectId: string; content: string }; result: { ok: true } }
  'projects.confirmPlan': { params: { projectId: string; tasks?: Array<Record<string, unknown>> }; result: { ok: true } }
  'projects.rejectPlan': { params: { projectId: string }; result: { ok: true } }
  'projects.setModel': { params: { projectId: string; model: string }; result: { ok: true } }
  'video.init': { params: { projectDir: string; template: string; resolution?: string; tailwind?: boolean }; result: { success: boolean; error?: string } }
  'video.addBlock': { params: { projectDir: string; block: string }; result: { success: boolean; error?: string } }
  'video.render': { params: { projectDir: string; output?: string; quality?: string; format?: string; fps?: string; strict?: boolean }; result: { success: boolean; error?: string; output?: string } }
  'video.preview': { params: { projectDir: string; port?: string }; result: { success: boolean; error?: string; port?: string } }
  'video.list': { params: { type?: string }; result: { success: boolean; error?: string; items?: Array<{ name: string; type: string }> } }
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
