import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { LaunchJob, LaunchHandle, SandboxReport, ProjectLauncher } from './manager.js'

const here = dirname(fileURLToPath(import.meta.url))
const workerPath = join(here, '..', '..', 'worker', 'sandboxed-worker.mjs')

const WORKER_ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'NODE_ENV'] as const

function buildWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * Outer bound on a single tool call. A worker that accepts a call and never
 * answers used to hang its caller forever: the master loop has no watchdog,
 * so one wedged call stalled the whole run.
 */
const DEFAULT_CALL_TIMEOUT_MS = Number(process.env.VAJRA_TOOL_TIMEOUT_MS) || 300_000

/** Grace added on top of a timeout the caller asked for (e.g. run_command),
 * so the worker's own deadline is the one that fires first. */
const CALL_TIMEOUT_GRACE_MS = Number(process.env.VAJRA_TOOL_TIMEOUT_GRACE_MS) || 30_000

function callTimeoutMs(args: unknown): number {
  const requested = (args as { timeout?: unknown } | null | undefined)?.timeout
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return requested + CALL_TIMEOUT_GRACE_MS
  }
  return DEFAULT_CALL_TIMEOUT_MS
}

interface PendingCall {
  resolve(result: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** Exported for tests: drives the IPC protocol against a fake child. */
export class WorkerHandle implements LaunchHandle {
  private pending = new Map<string, PendingCall>()
  private dead = false

  constructor(private child: ChildProcess) {
    child.on('message', (message: unknown) => {
      const msg = message as { type?: string; callId?: string; ok?: boolean; result?: unknown; error?: string }
      if (msg?.type !== 'result' || !msg.callId) return

      const pending = this.take(msg.callId)
      if (!pending) return

      if (msg.ok) {
        pending.resolve(msg.result)
      } else {
        pending.reject(new Error(msg.error))
      }
    })

    // Reject all pending calls if the worker process exits or crashes
    child.on('exit', (code) => {
      this.dead = true
      this.rejectAll(new Error(`Worker exited with code ${code}`))
    })

    child.on('error', (err) => {
      this.dead = true
      this.rejectAll(err)
    })
  }

  /** Remove a pending call and cancel its timeout. */
  private take(callId: string): PendingCall | undefined {
    const pending = this.pending.get(callId)
    if (!pending) return undefined
    clearTimeout(pending.timer)
    this.pending.delete(callId)
    return pending
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  callTool(tool: string, args: unknown): Promise<unknown> {
    if (this.dead) {
      return Promise.reject(new Error('Worker process is no longer running'))
    }
    const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timeoutMs = callTimeoutMs(args)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.take(callId)
        if (!pending) return
        // A worker that blew its deadline cannot be trusted for the next
        // task, and the pool would otherwise hand it straight back out.
        this.dead = true
        this.child.kill()
        pending.reject(new Error(`Tool '${tool}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(callId, { resolve, reject, timer })

      this.child.send({ type: 'call', callId, tool, args }, (err) => {
        if (!err) return
        const pending = this.take(callId)
        pending?.reject(err)
      })
    })
  }

  stop(): void {
    this.dead = true
    this.rejectAll(new Error('Project stopped'))
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
