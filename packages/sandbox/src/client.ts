// Client SDK for connecting to the sandbox daemon.
//
// Provides a typed API for agents to:
//  - Register with the daemon
//  - Acquire/release file locks
//  - Check file permissions
//  - Query daemon status
//
// Usage:
//   import { SandboxClient } from '@vajra/sandbox/client'
//   const client = new SandboxClient({ socketPath: '/tmp/vajra-sandbox-xxx.sock' })
//   await client.connect()
//   const { id } = await client.register('my-agent')
//   const { acquired } = await client.acquireLock(['src/index.ts'], id, 'write')
//   const { allowed } = await client.checkPermission('src/index.ts', 'write')
//   await client.disconnect()

import { createConnection, type Socket } from 'node:net'
import type { LockMode } from './file-locks.js'

// ---- Types ----

export interface ClientConfig {
  /** Path to the daemon's Unix socket. */
  socketPath: string
  /** Timeout for requests in ms. Default: 5000 */
  timeout?: number
}

export interface AgentInfo {
  id: string
  name: string
  connectedAt: number
  pid?: number
}

export interface DaemonStatus {
  running: boolean
  projectDir: string
  socketPath: string
  agents: AgentInfo[]
  locks: Array<{ file: string; owner: string; mode: LockMode; acquiredAt: number }>
  config: {
    defaultPermissions: { read: boolean; write: boolean; edit: boolean; delete: boolean }
    fileRulesCount: number
    allowedTools: string[] | null
  }
}

// ---- Client ----

export class SandboxClient {
  private socketPath: string
  private timeout: number
  private socket: Socket | null = null
  private connected = false
  private pendingRequests = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private buffer = ''

  constructor(config: ClientConfig) {
    this.socketPath = config.socketPath
    this.timeout = config.timeout ?? 5000
  }

  /** Connect to the daemon. */
  async connect(): Promise<void> {
    if (this.connected) return

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)

      socket.on('connect', () => {
        this.socket = socket
        this.connected = true
        resolve()
      })

      socket.on('data', (data) => {
        this.buffer += data.toString()
        // Process complete lines (newline-delimited JSON)
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) {
            this.handleResponse(line)
          }
        }
      })

      socket.on('error', (err) => {
        this.connected = false
        reject(err)
      })

      socket.on('close', () => {
        this.connected = false
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timer)
          pending.reject(new Error('Connection closed'))
          this.pendingRequests.delete(id)
        }
      })
    })
  }

  /** Disconnect from the daemon. */
  async disconnect(): Promise<void> {
    if (!this.connected || !this.socket) return

    return new Promise((resolve) => {
      this.socket!.end(() => {
        this.connected = false
        this.socket = null
        resolve()
      })
    })
  }

  /** Check if connected to the daemon. */
  get isConnected(): boolean {
    return this.connected
  }

  /** Register as an agent with the daemon. */
  async register(name: string, pid?: number): Promise<{ id: string }> {
    return this.send({ type: 'register', name, pid })
  }

  /** Acquire file locks. */
  async acquireLock(
    files: string[],
    ownerId: string,
    mode: LockMode = 'write',
  ): Promise<{ acquired: boolean }> {
    return this.send({ type: 'acquire', files, ownerId, mode })
  }

  /** Release all locks held by an owner. */
  async releaseLock(ownerId: string): Promise<void> {
    return this.send({ type: 'release', ownerId })
  }

  /** Release specific file locks. */
  async releaseFiles(files: string[], ownerId: string): Promise<void> {
    return this.send({ type: 'releaseFiles', files, ownerId })
  }

  /** Check if a file operation is permitted by the sandbox config. */
  async checkPermission(
    filePath: string,
    operation: 'read' | 'write' | 'edit' | 'delete',
  ): Promise<{ allowed: boolean; reason?: string }> {
    return this.send({ type: 'check', filePath, operation })
  }

  /** Get daemon status. */
  async getStatus(): Promise<{ ok: true; status: DaemonStatus }> {
    return this.send({ type: 'status' })
  }

  /** List connected agents. */
  async listAgents(): Promise<{ ok: true; agents: AgentInfo[] }> {
    return this.send({ type: 'agents' })
  }

  /** List all current file locks. */
  async listLocks(): Promise<{ ok: true; locks: Array<{ file: string; owner: string; mode: LockMode; acquiredAt: number }> }> {
    return this.send({ type: 'locks' })
  }

  /** Ping the daemon. */
  async ping(): Promise<boolean> {
    try {
      await this.send({ type: 'ping' })
      return true
    } catch {
      return false
    }
  }

  // ---- Internal ----

  private send<T>(request: unknown): Promise<T> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Not connected to daemon'))
    }

    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2)

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timed out after ${this.timeout}ms`))
      }, this.timeout)

      this.pendingRequests.set(id, { resolve, reject, timer })

      // Send request (wrapped in array for batch protocol)
      this.socket!.write(JSON.stringify([request]) + '\n')

      // Note: Response matching is simplified — in production, you'd include
      // the request ID in the response. For now, we process responses in order.
    })
  }

  private handleResponse(line: string): void {
    try {
      const response = JSON.parse(line)

      // Get the first pending request (simplified matching)
      const entries = [...this.pendingRequests.entries()]
      if (entries.length === 0) return

      const [id, pending] = entries[0]
      clearTimeout(pending.timer)
      this.pendingRequests.delete(id)

      if (response.ok) {
        pending.resolve(response)
      } else {
        pending.reject(new Error(response.error ?? 'Unknown error'))
      }
    } catch {
      // Ignore parse errors
    }
  }
}
