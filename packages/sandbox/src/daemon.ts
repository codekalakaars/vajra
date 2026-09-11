// Sandbox daemon — manages file locks, permissions, and agent connections.
// Listens on a Unix socket for agent connections.

import { createServer, type Server, type Socket } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { FileLockManager, type LockMode } from './file-locks.js'
import { resolveFilePermission, matchesPattern } from './file-rules.js'
import type { FileRule } from './config.js'
import type { FilePermissions } from './types.js'

export interface DaemonConfig {
  projectDir: string
  socketPath: string
  environment?: string
}

interface ConnectedAgent {
  id: string
  name: string
  pid?: number
  socket: Socket
  connectedAt: number
}

interface DaemonRequest {
  type: string
  [key: string]: unknown
}

interface DaemonResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export class SandboxDaemon {
  private server: Server | null = null
  private agents = new Map<string, ConnectedAgent>()
  private locks = new FileLockManager()
  private fileRules: FileRule[] = []
  private defaultPermissions: FilePermissions = {
    read: true,
    write: false,
    edit: false,
    delete: false,
  }
  private allowedTools: string[] | null = null
  private agentCounter = 0

  constructor(private config: DaemonConfig) {}

  async start(): Promise<void> {
    this.loadConfig()

    this.server = createServer((socket) => this.handleConnection(socket))

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject)
      this.server!.listen(this.config.socketPath, () => {
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    this.locks.clear()

    for (const agent of this.agents.values()) {
      agent.socket.destroy()
    }
    this.agents.clear()

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  private loadConfig(): void {
    const configPath = `${this.config.projectDir}/.vajra-sandbox.json`
    if (!existsSync(configPath)) return

    try {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)

      const envConfig = this.config.environment
        ? parsed.environments?.[this.config.environment]
        : parsed

      if (envConfig) {
        if (envConfig.fileRules) this.fileRules = envConfig.fileRules
        if (envConfig.defaultPermissions) {
          this.defaultPermissions = {
            read: envConfig.defaultPermissions.read ?? true,
            write: envConfig.defaultPermissions.write ?? false,
            edit: envConfig.defaultPermissions.edit ?? false,
            delete: envConfig.defaultPermissions.delete ?? false,
          }
        }
        if (envConfig.allowedTools) this.allowedTools = envConfig.allowedTools
      }
    } catch {}
  }

  private handleConnection(socket: Socket): void {
    const agentId = `agent-${++this.agentCounter}-${Date.now()}`

    const agent: ConnectedAgent = {
      id: agentId,
      name: 'unknown',
      socket,
      connectedAt: Date.now(),
    }

    this.agents.set(agentId, agent)

    socket.on('data', (data) => {
      try {
        const request: DaemonRequest = JSON.parse(data.toString())
        this.handleRequest(agent, request)
      } catch (e) {
        this.sendResponse(agent, {
          ok: false,
          error: `Invalid request: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    })

    socket.on('close', () => {
      this.locks.releaseAll(agentId)
      this.agents.delete(agentId)
    })

    socket.on('error', () => {
      this.locks.releaseAll(agentId)
      this.agents.delete(agentId)
    })
  }

  private handleRequest(agent: ConnectedAgent, request: DaemonRequest): void {
    switch (request.type) {
      case 'identify':
        agent.name = String(request.name || 'unknown')
        agent.pid = Number(request.pid) || undefined
        this.sendResponse(agent, { ok: true })
        break
      case 'lock':
        this.handleLock(agent, request)
        break
      case 'unlock':
        this.handleUnlock(agent, request)
        break
      case 'check-permission':
        this.handleCheckPermission(agent, request)
        break
      case 'check-tool':
        this.handleCheckTool(agent, request)
        break
      case 'status':
        this.handleStatus(agent)
        break
      case 'list-locks':
        this.handleListLocks(agent)
        break
      case 'list-agents':
        this.handleListAgents(agent)
        break
      default:
        this.sendResponse(agent, {
          ok: false,
          error: `Unknown request type: ${request.type}`,
        })
    }
  }

  private handleLock(agent: ConnectedAgent, request: DaemonRequest): void {
    const file = String(request.file || '')
    const mode = (String(request.mode || 'shared') as LockMode)

    if (!file) {
      this.sendResponse(agent, { ok: false, error: 'Missing file path' })
      return
    }

    const result = this.locks.acquire(file, agent.id, mode)
    this.sendResponse(agent, { ...result, lock: result.lock ?? undefined })
  }

  private handleUnlock(agent: ConnectedAgent, request: DaemonRequest): void {
    const file = String(request.file || '')
    if (!file) {
      this.sendResponse(agent, { ok: false, error: 'Missing file path' })
      return
    }

    const released = this.locks.release(file, agent.id)
    this.sendResponse(agent, { ok: released })
  }

  private handleCheckPermission(agent: ConnectedAgent, request: DaemonRequest): void {
    const file = String(request.file || '')
    const operation = String(request.operation || 'read') as keyof FilePermissions

    if (!file) {
      this.sendResponse(agent, { ok: false, error: 'Missing file path' })
      return
    }

    const perm = this.resolveFilePermission(file)
    const allowed = perm[operation] ?? false

    this.sendResponse(agent, { ok: true, allowed, permissions: perm })
  }

  private handleCheckTool(agent: ConnectedAgent, request: DaemonRequest): void {
    const tool = String(request.tool || '')
    if (this.allowedTools === null) {
      this.sendResponse(agent, { ok: true, allowed: true })
      return
    }

    const allowed = this.allowedTools.includes(tool)
    this.sendResponse(agent, { ok: true, allowed })
  }

  private handleStatus(agent: ConnectedAgent): void {
    this.sendResponse(agent, {
      ok: true,
      status: {
        projectDir: this.config.projectDir,
        socketPath: this.config.socketPath,
        agents: [...this.agents.values()].map((a) => ({
          id: a.id,
          name: a.name,
          pid: a.pid,
          connectedAt: a.connectedAt,
        })),
        locks: this.locks.list(),
        config: {
          defaultPermissions: this.defaultPermissions,
          fileRulesCount: this.fileRules.length,
          allowedTools: this.allowedTools,
        },
      },
    })
  }

  private handleListLocks(agent: ConnectedAgent): void {
    this.sendResponse(agent, {
      ok: true,
      locks: this.locks.list(),
    })
  }

  private handleListAgents(agent: ConnectedAgent): void {
    this.sendResponse(agent, {
      ok: true,
      agents: [...this.agents.values()].map((a) => ({
        id: a.id,
        name: a.name,
        pid: a.pid,
        connectedAt: a.connectedAt,
      })),
    })
  }

  private resolveFilePermission(filePath: string): FilePermissions {
    const result = { ...this.defaultPermissions }
    for (const rule of this.fileRules) {
      if (matchesPattern(filePath, rule.pattern)) {
        if (rule.read !== undefined) result.read = rule.read
        if (rule.write !== undefined) result.write = rule.write
        if (rule.edit !== undefined) result.edit = rule.edit
        if (rule.delete !== undefined) result.delete = rule.delete
      }
    }
    return result
  }

  private sendResponse(agent: ConnectedAgent, response: DaemonResponse): void {
    const data = JSON.stringify(response) + '\n'
    agent.socket.write(data)
  }
}
