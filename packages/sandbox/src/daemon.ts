// Standalone sandbox daemon.
//
// Manages file locks, permission checks, and agent coordination.
// Listens on a Unix socket for agent connections.
//
// Usage:
//   import { SandboxDaemon } from '@vajra/sandbox/daemon'
//   const daemon = new SandboxDaemon({ projectDir: '/path/to/project' })
//   await daemon.start()
//   // ... agents connect via socket ...
//   await daemon.stop()

import { createServer, type Server, type Socket } from 'node:net'
import { unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FileLockManager, type Lock, type LockMode } from './file-locks.js'
import { createSandboxConfig, type SandboxConfig, type FileRule } from './config.js'
import { loadSandboxConfig, DEFAULT_CONFIG_FILE } from './file-config.js'
import { resolveFilePermission } from './file-rules.js'

// ---- Types ----

export interface DaemonConfig {
  projectDir: string
  /** Socket path. Defaults to /tmp/vajra-sandbox-{projectDir-hash}.sock */
  socketPath?: string
  /** Sandbox environment name. Defaults to 'default'. */
  environment?: string
  /** Whether to load config from .vajra-sandbox.json. Default: true */
  loadConfig?: boolean
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

// ---- IPC Protocol ----

type DaemonRequest =
  | { type: 'register'; name: string; pid?: number }
  | { type: 'acquire'; files: string[]; ownerId: string; mode: LockMode }
  | { type: 'release'; ownerId: string }
  | { type: 'releaseFiles'; files: string[]; ownerId: string }
  | { type: 'check'; filePath: string; operation: 'read' | 'write' | 'edit' | 'delete' }
  | { type: 'status' }
  | { type: 'agents' }
  | { type: 'locks' }
  | { type: 'ping' }

type DaemonResponse =
  | { ok: true; id: string }
  | { ok: true; acquired: boolean }
  | { ok: true }
  | { ok: true; allowed: boolean; reason?: string }
  | { ok: true; status: DaemonStatus }
  | { ok: true; agents: AgentInfo[] }
  | { ok: true; locks: Array<{ file: string; owner: string; mode: LockMode; acquiredAt: number }> }
  | { ok: true }
  | { ok: false; error: string }

// ---- Daemon ----

export class SandboxDaemon {
  private server: Server | null = null
  private config: DaemonConfig
  private projectDir: string
  private socketPath: string

  private fileLocks = new FileLockManager()
  private agents = new Map<string, AgentInfo>()
  private sockets = new Map<string, Socket>()
  private sandboxConfig: SandboxConfig | null = null

  private _running = false
  private _startedAt: number | null = null

  constructor(config: DaemonConfig) {
    this.config = config
    this.projectDir = config.projectDir
    this.socketPath = config.socketPath ?? this.defaultSocketPath()
  }

  /** Start the daemon. Idempotent — calling on an already-running daemon is a no-op. */
  async start(): Promise<void> {
    if (this._running) return

    // Load sandbox config if requested
    if (this.config.loadConfig !== false) {
      this.sandboxConfig = loadSandboxConfig(
        this.projectDir,
        this.config.environment,
      )
    }

    // Remove stale socket if it exists
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // Ignore — socket may be in use by another process
      }
    }

    // Ensure socket directory exists
    const socketDir = dirname(this.socketPath)
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true })
    }

    // Create the server
    this.server = createServer((socket) => this.handleConnection(socket))

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.socketPath, () => {
        this._running = true
        this._startedAt = Date.now()
        resolve()
      })
    })
  }

  /** Stop the daemon and clean up. */
  async stop(): Promise<void> {
    if (!this._running) return

    // Close all agent connections
    for (const [id, socket] of this.sockets) {
      socket.destroy()
      this.sockets.delete(id)
    }
    this.agents.clear()

    // Close the server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this._running = false
          this._startedAt = null
          // Remove socket file
          try {
            unlinkSync(this.socketPath)
          } catch {
            // Ignore
          }
          resolve()
        })
      } else {
        this._running = false
        resolve()
      }
    })
  }

  /** Check if the daemon is running. */
  get running(): boolean {
    return this._running
  }

  /** Get daemon status. */
  getStatus(): DaemonStatus {
    const locksMap = this.fileLocks.getLocks()
    const locks: Array<{ file: string; owner: string; mode: LockMode; acquiredAt: number }> = []
    for (const [file, fileLocks] of locksMap) {
      for (const lock of fileLocks) {
        locks.push({ file, owner: lock.owner, mode: lock.mode, acquiredAt: lock.acquiredAt })
      }
    }

    return {
      running: this._running,
      projectDir: this.projectDir,
      socketPath: this.socketPath,
      agents: [...this.agents.values()],
      locks,
      config: this.sandboxConfig
        ? {
            defaultPermissions: { ...this.sandboxConfig.defaultPermissions },
            fileRulesCount: this.sandboxConfig.fileRules.length,
            allowedTools: this.sandboxConfig.allowedTools
              ? [...this.sandboxConfig.allowedTools]
              : null,
          }
        : {
            defaultPermissions: { read: true, write: false, edit: false, delete: false },
            fileRulesCount: 0,
            allowedTools: null,
          },
    }
  }

  // ---- Internal ----

  private handleConnection(socket: Socket): void {
    let agentId: string | null = null

    socket.on('data', (data) => {
      try {
        const requests = JSON.parse(data.toString()) as DaemonRequest[]
        for (const request of requests) {
          const response = this.handleRequest(request, agentId)
          socket.write(JSON.stringify(response) + '\n')

          // Track agent ID after registration
          if (request.type === 'register' && response.ok) {
            agentId = (response as { ok: true; id: string }).id
          }
        }
      } catch (e) {
        socket.write(
          JSON.stringify({ ok: false, error: `Invalid request: ${e instanceof Error ? e.message : String(e)}` }) + '\n',
        )
      }
    })

    socket.on('close', () => {
      if (agentId) {
        this.agents.delete(agentId)
        this.sockets.delete(agentId)
        // Release all locks held by this agent
        this.fileLocks.release(agentId)
      }
    })

    socket.on('error', () => {
      // Ignore socket errors — cleanup happens in 'close'
    })
  }

  private handleRequest(request: DaemonRequest, agentId: string | null): DaemonResponse {
    switch (request.type) {
      case 'register':
        return this.handleRegister(request)
      case 'acquire':
        return this.handleAcquire(request)
      case 'release':
        return this.handleRelease(request)
      case 'releaseFiles':
        return this.handleReleaseFiles(request)
      case 'check':
        return this.handleCheck(request)
      case 'status':
        return { ok: true, status: this.getStatus() }
      case 'agents':
        return { ok: true, agents: [...this.agents.values()] }
      case 'locks': {
        const locksMap = this.fileLocks.getLocks()
        const locks: Array<{ file: string; owner: string; mode: LockMode; acquiredAt: number }> = []
        for (const [file, fileLocks] of locksMap) {
          for (const lock of fileLocks) {
            locks.push({ file, owner: lock.owner, mode: lock.mode, acquiredAt: lock.acquiredAt })
          }
        }
        return { ok: true, locks }
      }
      case 'ping':
        return { ok: true }
      default:
        return { ok: false, error: `Unknown request type: ${(request as any).type}` }
    }
  }

  private handleRegister(request: { type: 'register'; name: string; pid?: number }): DaemonResponse {
    const id = randomUUID()
    const agent: AgentInfo = {
      id,
      name: request.name,
      connectedAt: Date.now(),
      pid: request.pid,
    }
    this.agents.set(id, agent)
    return { ok: true, id }
  }

  private handleAcquire(request: { type: 'acquire'; files: string[]; ownerId: string; mode: LockMode }): DaemonResponse {
    const acquired = this.fileLocks.tryAcquire(request.files, request.ownerId, request.mode)
    return { ok: true, acquired }
  }

  private handleRelease(request: { type: 'release'; ownerId: string }): DaemonResponse {
    this.fileLocks.release(request.ownerId)
    return { ok: true }
  }

  private handleReleaseFiles(request: { type: 'releaseFiles'; files: string[]; ownerId: string }): DaemonResponse {
    this.fileLocks.releaseFiles(request.files, request.ownerId)
    return { ok: true }
  }

  private handleCheck(request: { type: 'check'; filePath: string; operation: 'read' | 'write' | 'edit' | 'delete' }): DaemonResponse {
    if (!this.sandboxConfig) {
      // No config loaded — allow everything
      return { ok: true, allowed: true }
    }

    const perm = resolveFilePermission(this.sandboxConfig, request.filePath)
    const allowed = perm[request.operation]

    if (!allowed) {
      return {
        ok: true,
        allowed: false,
        reason: `Operation '${request.operation}' not permitted on '${request.filePath}'`,
      }
    }

    return { ok: true, allowed: true }
  }

  private defaultSocketPath(): string {
    // Use a hash of the project dir for the socket name
    const hash = Buffer.from(this.projectDir).toString('base64url').slice(0, 32)
    return `/tmp/vajra-sandbox-${hash}.sock`
  }
}
