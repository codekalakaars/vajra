import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { LaunchJob, LaunchHandle, SandboxReport, ProjectLauncher } from './manager.js'

const here = dirname(fileURLToPath(import.meta.url))
const workerPath = join(here, '..', '..', 'worker', 'sandboxed-worker.mjs')

const WORKER_ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'] as const

function buildWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

interface PendingCall {
  resolve(result: unknown): void
  reject(error: Error): void
}

class WorkerHandle implements LaunchHandle {
  private pending = new Map<string, PendingCall>()

  constructor(private child: ChildProcess) {
    child.on('message', (message: unknown) => {
      const msg = message as { type?: string; callId?: string; ok?: boolean; result?: unknown; error?: string }
      if (msg?.type !== 'result' || !msg.callId) return

      const pending = this.pending.get(msg.callId)
      if (!pending) return
      this.pending.delete(msg.callId)

      if (msg.ok) {
        pending.resolve(msg.result)
      } else {
        pending.reject(new Error(msg.error))
      }
    })
  }

  callTool(tool: string, args: unknown): Promise<unknown> {
    const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve, reject) => {
      this.pending.set(callId, { resolve, reject })
      this.child.send({ type: 'call', callId, tool, args })
    })
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Project stopped'))
    }
    this.pending.clear()
    this.child.kill()
  }
}

export const forkProjectLauncher: ProjectLauncher = (job: LaunchJob, onSandboxReport) => {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      env: buildWorkerEnv(),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })

    let settled = false

    child.once('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })

    child.once('exit', (code) => {
      if (!settled) {
        settled = true
        reject(new Error(`Sandbox worker exited before reporting (code ${code})`))
      }
    })

    child.on('message', (message: unknown) => {
      const msg = message as { type?: string; message?: string; report?: SandboxReport }

      if (msg?.type === 'refused') {
        settled = true
        child.kill()
        reject(new Error(msg.message))
        return
      }

      if (msg?.type === 'sandbox-report' && msg.report) {
        onSandboxReport(msg.report)
        if (!settled) {
          settled = true
          resolve(new WorkerHandle(child))
        }
      }
    })

    child.send({ type: 'job', job })
  })
}
