// Client SDK for connecting to the sandbox daemon.
// Sends JSON requests over Unix socket, parses newline-delimited JSON responses.
// Responses are correlated by request id so concurrent calls cannot resolve
// each other's pending promises.

import { connect, type Socket } from 'node:net'
import type { LockMode } from './file-locks.js'
import type { FilePermissions } from './types.js'

export interface ClientConfig {
  socketPath: string
  timeoutMs?: number
}

interface DaemonResponse {
  ok: boolean
  error?: string
  id?: string | number
  [key: string]: unknown
}

interface PendingRequest {
  resolve: (response: DaemonResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SandboxClient {
  private socket: Socket | null = null
  private buffer = ''
  private pending = new Map<string | number, PendingRequest>()
  private nextId = 1
  private timeoutMs: number

  constructor(private config: ClientConfig) {
    this.timeoutMs = config.timeoutMs ?? 5000
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = connect(this.config.socketPath)

      this.socket.on('connect', () => resolve())
      this.socket.on('error', reject)

      this.socket.on('data', (data) => {
        this.buffer += data.toString()
        while (true) {
          const nl = this.buffer.indexOf('\n')
          if (nl === -1) break
          const line = this.buffer.slice(0, nl)
          this.buffer = this.buffer.slice(nl + 1)
          try {
            const response: DaemonResponse = JSON.parse(line)
            const id = response.id
            if (id === undefined) continue
            const entry = this.pending.get(id)
            if (entry) {
              this.pending.delete(id)
              clearTimeout(entry.timer)
              entry.resolve(response)
            }
          } catch {}
        }
      })
    })
  }

  async disconnect(): Promise<void> {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Disconnected'))
    }
    this.pending.clear()
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.end(() => resolve())
      } else {
        resolve()
      }
    })
  }

  private async send(request: Record<string, unknown>): Promise<DaemonResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected'))
        return
      }

      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Request timed out'))
      }, this.timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(JSON.stringify({ ...request, id }) + '\n', (err) => {
        if (err) {
          const entry = this.pending.get(id)
          if (entry) {
            this.pending.delete(id)
            clearTimeout(entry.timer)
            entry.reject(err)
          }
        }
      })
    })
  }

  async identify(name: string, pid?: number): Promise<{ ok: boolean; error?: string }> {
    return this.send({ type: 'identify', name, pid }) as Promise<{ ok: boolean; error?: string }>
  }

  async lock(file: string, mode: LockMode = 'read'): Promise<{ ok: boolean; error?: string }> {
    return this.send({ type: 'lock', file, mode }) as Promise<{ ok: boolean; error?: string }>
  }

  async unlock(file: string): Promise<{ ok: boolean }> {
    return this.send({ type: 'unlock', file }) as Promise<{ ok: boolean }>
  }

  async checkPermission(
    file: string,
    operation: keyof FilePermissions = 'read',
  ): Promise<{ ok: boolean; allowed: boolean; permissions: FilePermissions }> {
    return this.send({ type: 'check-permission', file, operation }) as Promise<{
      ok: boolean
      allowed: boolean
      permissions: FilePermissions
    }>
  }

  async checkTool(tool: string): Promise<{ ok: boolean; allowed: boolean }> {
    return this.send({ type: 'check-tool', tool }) as Promise<{ ok: boolean; allowed: boolean }>
  }

  async getStatus(): Promise<{ ok: boolean; status: Record<string, unknown> }> {
    return this.send({ type: 'status' }) as Promise<{ ok: boolean; status: Record<string, unknown> }>
  }

  async listLocks(): Promise<{ ok: boolean; locks: Array<Record<string, unknown>> }> {
    return this.send({ type: 'list-locks' }) as Promise<{
      ok: boolean
      locks: Array<Record<string, unknown>>
    }>
  }

  async listAgents(): Promise<{ ok: boolean; agents: Array<Record<string, unknown>> }> {
    return this.send({ type: 'list-agents' }) as Promise<{
      ok: boolean
      agents: Array<Record<string, unknown>>
    }>
  }
}
