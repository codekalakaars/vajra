// Parent side of the CLI sandboxed worker (Group Q).
//
// Forks dist/sandbox/worker.js, sends a buildLaunchJob() payload, waits for
// the sandbox-report, and exposes tool calls as a LaunchHandle over IPC.
// The parent never calls applySandbox itself.

import { fork, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaunchHandle } from '../agent/developer.js'
import {
  buildLaunchJob,
  createSandboxConfig,
  loadSandboxConfig,
  type LaunchJob,
  type SandboxConfig,
} from '@codekalakaars/vajra-sandbox'
import { normalizeProjectPath, type TaskFilePermissions } from '../tasks/permissions.js'
import {
  resolveConcurrencyConfig,
  WorkerPool,
  type PoolWorker,
  type WorkerLease,
} from '@codekalakaars/vajra-sandbox'

export interface SandboxReport {
  enforced: boolean
  mechanism: string
  warnings: string[]
}

export interface SandboxSession {
  handle: LaunchHandle
  report: SandboxReport
  /** Swap app-level task file permissions for the session handle. */
  setTaskPermissions: (lookup: (path: string) => TaskFilePermissions | null) => void
  /** Parent-side dirty hook for the session handle: fired after a successful mutating tool. */
  setOnMutate: (fn: () => void) => void
  /**
   * Register per-task permission lookup and dirty hook, returning a handle
   * whose tool calls consult that task's state only (P1).
   */
  handleForTask(
    taskId: string,
    lookup: (path: string) => TaskFilePermissions | null,
    onMutate: () => void,
  ): LaunchHandle
  /** Drop a task's scoped permission lookup and dirty hook. */
  releaseTask: (taskId: string) => void
  close: () => void
}

export interface LaunchSandboxOptions {
  /** Prefer an existing .vajra-sandbox.json when present. */
  allowUnenforced?: boolean
  /** Fail instead of returning a session when the platform cannot enforce. */
  requireEnforced?: boolean
  timeoutMs?: number
}

const WORKER_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'NODE_ENV',
] as const

function buildWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function resolveWorkerPath(): string {
  return fileURLToPath(new URL('./worker.js', import.meta.url))
}

/**
 * The worker must be able to re-exec the Node interpreter under Landlock.
 * nvm/asdf/homebrew installs live outside the hardcoded /usr //bin grants, so
 * always merge process.execPath (and its bin dir for PATH lookup) into the
 * read+execute set — otherwise run_command dies with EACCES on `node`.
 */
function withNodeToolchain(paths: readonly string[]): string[] {
  const nodeBin = process.execPath
  const nodeBinDir = dirname(nodeBin)
  const merged = new Set(paths)
  merged.add(nodeBin)
  merged.add(nodeBinDir)
  return [...merged]
}

function resolveSandboxConfig(projectDir: string, allowUnenforced: boolean): SandboxConfig {
  const loaded = loadSandboxConfig(projectDir)
  if (loaded) {
    // CLI UX: never hard-fail on Windows when the user has no opinion set.
    if (allowUnenforced && loaded.allowUnenforced === false && loaded.fileRules.length === 0) {
      return createSandboxConfig({
        projectDir,
        allowUnenforced: true,
        fileRules: [...loaded.fileRules],
        defaultPermissions: { ...loaded.defaultPermissions },
        allowedTools: loaded.allowedTools ? [...loaded.allowedTools] : undefined,
        readExecutePaths: withNodeToolchain(loaded.readExecutePaths),
        readWritePaths: [...loaded.readWritePaths],
      })
    }
    return createSandboxConfig({
      projectDir,
      allowUnenforced: loaded.allowUnenforced,
      fileRules: [...loaded.fileRules],
      defaultPermissions: { ...loaded.defaultPermissions },
      allowedTools: loaded.allowedTools ? [...loaded.allowedTools] : undefined,
      readExecutePaths: withNodeToolchain(loaded.readExecutePaths),
      readWritePaths: [...loaded.readWritePaths],
    })
  }
  // No project config: grant full in-project access. The OS sandbox confines
  // the worker; app-level task permissions (parent) gate which paths each task
  // may touch. write:false here would make every write_file fail.
  return createSandboxConfig({
    projectDir,
    allowUnenforced,
    defaultPermissions: { read: true, write: true, edit: true, delete: true },
    readExecutePaths: withNodeToolchain([]),
  })
}

/**
 * App-level permission gate applied in the parent before a call is forwarded.
 * With no lookup for the scope the call is unrestricted; with a lookup, paths
 * it does not know about are denied.
 */
function assertToolPermission(
  lookup: ((path: string) => TaskFilePermissions | null) | undefined,
  tool: string,
  args: unknown,
): void {
  if (!lookup) return
  if (tool === 'list_files' || tool === 'search_files') return
  const a = (args ?? {}) as { path?: unknown }
  if (typeof a.path !== 'string') return
  const perm = lookup(a.path)
  const op =
    tool === 'read_file'
      ? 'read'
      : tool === 'write_file' || tool === 'create_dir'
        ? 'write'
        : tool === 'edit_file'
          ? 'edit'
          : tool === 'delete_file'
            ? 'delete'
            : null
  if (op && perm && !perm[op]) {
    throw new Error(`Access denied: ${a.path}`)
  }
  if (op && !perm) {
    throw new Error(`Access denied: ${a.path}`)
  }
}

/**
 * Fork the sandboxed worker and return a LaunchHandle that proxies tool calls
 * over IPC. Throws if the worker refuses to start or applySandbox fails.
 */
export async function launchSandboxSession(
  projectDir: string,
  sessionId: string,
  options: LaunchSandboxOptions = {},
): Promise<SandboxSession> {
  const allowUnenforced = options.allowUnenforced ?? false
  const requireEnforced = options.requireEnforced ?? !allowUnenforced
  const timeoutMs = options.timeoutMs ?? 15_000
  const config = resolveSandboxConfig(projectDir, allowUnenforced)
  const job: LaunchJob = buildLaunchJob(config, sessionId)

  const SESSION_SCOPE = '__session'
  const taskLookups = new Map<string, (path: string) => TaskFilePermissions | null>()
  const taskOnMutate = new Map<string, () => void>()
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; scope: string }
  >()
  let nextCallId = 1
  let activeChild: ChildProcess | null = null
  let closed = false
  let ready: Promise<SandboxReport>
  let restartAttempts = 0

  const stopWorker = (child: ChildProcess | null): void => {
    if (!child) return
    try {
      child.kill('SIGTERM')
    } catch {}
  }

  const failPending = (error: Error): void => {
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) entry.reject(error)
  }

  const startWorker = (): { child: ChildProcess; report: Promise<SandboxReport> } => {
    const spawnedChild = fork(resolveWorkerPath(), [], {
      cwd: projectDir,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: buildWorkerEnv(),
    })
    let reported = false
    let reportSettled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolveReport!: (report: SandboxReport) => void
    let rejectReport!: (error: Error) => void

    const report = new Promise<SandboxReport>((resolve, reject) => {
      resolveReport = resolve
      rejectReport = reject
      timer = setTimeout(() => {
        if (reportSettled) return
        reportSettled = true
        stopWorker(spawnedChild)
        rejectReport(new Error(`Sandbox worker did not report within ${timeoutMs}ms`))
      }, timeoutMs)
    })

    const onMessage = (message: {
      type?: string
      report?: SandboxReport
      message?: string
      callId?: string
      ok?: boolean
      result?: unknown
      error?: string
      mutated?: boolean
    }): void => {
      if (!message || spawnedChild !== activeChild) return

      if (message.type === 'sandbox-report' && message.report) {
        if (reportSettled) return
        if (requireEnforced && !message.report.enforced) {
          reportSettled = true
          if (timer) clearTimeout(timer)
          stopWorker(spawnedChild)
          rejectReport(new Error(`Sandbox not enforced: ${message.report.mechanism}`))
          return
        }
        reportSettled = true
        reported = true
        if (timer) clearTimeout(timer)
        resolveReport(message.report)
        return
      }

      if (message.type === 'refused') {
        if (reportSettled) return
        reportSettled = true
        if (timer) clearTimeout(timer)
        rejectReport(new Error(message.message ?? 'Sandbox worker refused to start'))
        return
      }

      if (message.type === 'result' && message.callId) {
        const entry = pending.get(message.callId)
        if (!entry) return
        pending.delete(message.callId)
        if (message.ok) {
          if (message.mutated) taskOnMutate.get(entry.scope)?.()
          entry.resolve(message.result)
        } else {
          entry.reject(new Error(message.error ?? 'Tool call failed in sandbox worker'))
        }
      }
    }

    const onExit = (code: number | null): void => {
      if (timer) clearTimeout(timer)
      const error = new Error(`Sandbox worker exited (code ${code})`)
      if (!reportSettled) {
        reportSettled = true
        rejectReport(error)
      }
      if (spawnedChild !== activeChild) return
      activeChild = null
      failPending(error)
      if (closed || !reported) return
      if (restartAttempts >= job.resourceLimits.maxSpawnRetries) {
        ready = Promise.reject(new Error('Sandbox worker exhausted its restart attempts'))
        void ready.catch(() => {})
        return
      }

      restartAttempts++
      try {
        const restarted = startWorker()
        activeChild = restarted.child
        ready = restarted.report
        void ready.catch(() => {})
      } catch (e) {
        ready = Promise.reject(e instanceof Error ? e : new Error(String(e)))
        void ready.catch(() => {})
      }
    }

    const onError = (error: Error) => {
      if (!reportSettled) {
        reportSettled = true
        if (timer) clearTimeout(timer)
        rejectReport(error)
      }
      if (spawnedChild === activeChild && reported) onExit(-1)
    }

    spawnedChild.on('error', onError)
    spawnedChild.on('message', onMessage)
    spawnedChild.once('exit', onExit)
    try {
      spawnedChild.send({ type: 'job', job })
    } catch (e) {
      stopWorker(spawnedChild)
      if (!reportSettled) {
        reportSettled = true
        if (timer) clearTimeout(timer)
        rejectReport(e instanceof Error ? e : new Error(String(e)))
      }
    }
    return { child: spawnedChild, report }
  }

  const initialWorker = startWorker()
  activeChild = initialWorker.child
  ready = initialWorker.report
  let report: SandboxReport
  try {
    report = await ready
  } catch (e) {
    const current = activeChild
    activeChild = null
    stopWorker(current)
    throw e
  }

  if (requireEnforced && !report.enforced) {
    const current = activeChild
    activeChild = null
    stopWorker(current)
    throw new Error(`Sandbox not enforced: ${report.mechanism}`)
  }

  const makeHandle = (scope: string): LaunchHandle => ({
    callTool: async (tool: string, args: unknown) => {
      assertToolPermission(taskLookups.get(scope), tool, args)

      for (;;) {
        const observedReady = ready
        await observedReady
        if (closed) throw new Error('Sandbox session closed')
        const current = activeChild
        if (!current || !current.connected) {
          if (ready !== observedReady) continue
          throw new Error('Sandbox worker unavailable')
        }

        const callId = String(nextCallId++)
        return new Promise((resolve, reject) => {
          pending.set(callId, { resolve, reject, scope })
          try {
            current.send({ type: 'call', callId, tool, args }, (err) => {
              if (!err) return
              pending.delete(callId)
              reject(err instanceof Error ? err : new Error(String(err)))
            })
          } catch (e) {
            pending.delete(callId)
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      }
    },
  })

  const handle = makeHandle(SESSION_SCOPE)

  return {
    handle,
    report,
    setTaskPermissions: (lookup) => {
      taskLookups.set(SESSION_SCOPE, lookup)
    },
    setOnMutate: (fn) => {
      taskOnMutate.set(SESSION_SCOPE, fn)
    },
    handleForTask: (taskId, lookup, onMutate) => {
      taskLookups.set(taskId, lookup)
      taskOnMutate.set(taskId, onMutate)
      return makeHandle(taskId)
    },
    releaseTask: (taskId) => {
      taskLookups.delete(taskId)
      taskOnMutate.delete(taskId)
    },
    close: () => {
      if (closed) return
      closed = true
      failPending(new Error('Sandbox session closed'))
      const current = activeChild
      activeChild = null
      if (current) {
        if (current.connected) {
          try {
            current.send({ type: 'shutdown' })
          } catch {}
        }
        stopWorker(current)
      }
    },
  }
}

/** Build a permission lookup from a task permissions map (normalized keys). */
export function taskPermissionLookupFrom(
  projectDir: string,
  permissions: Record<string, TaskFilePermissions>,
): (path: string) => TaskFilePermissions | null {
  return (path) => {
    const key = normalizeProjectPath(projectDir, path)
    return permissions[key] ?? null
  }
}

/** A pooled worker that remembers the session it drives. */
interface SessionWorker extends PoolWorker {
  session: SandboxSession
}

/**
 * A `SandboxSession` backed by a pool of real sessions — one per in-flight
 * task.
 *
 * The point is blast radius. With one shared worker, a single OOM or native
 * fault fails every in-flight task at once: the worker respawns, but the calls
 * already in flight on the dead process are gone, and so are the tasks that
 * were waiting on them. Giving each task its own worker means a crash costs one
 * task.
 *
 * `service.ts` needs no change for any of this — the pool implements the same
 * `SandboxSession` surface, so admission, permission scoping and reporting work
 * exactly as before. Per-task scoping is not weakened either: each task still
 * gets `handleForTask` on its own session, so a worker is never shared with
 * another task while either of them is running.
 *
 * Workers are created lazily, so a single-task run forks exactly one worker as
 * before. `handleForTask` is synchronous by contract, so a reservation can be a
 * session that is still starting; the handle it returns awaits that session on
 * first use.
 */
export async function launchSandboxSessionPool(
  projectDir: string,
  sessionId: string,
  options: LaunchSandboxOptions = {},
): Promise<SandboxSession> {
  // The primary session backs the session-scope handle (planning, rollback) and
  // the first task, so nothing is forked that would not have been before.
  const primary = await launchSandboxSession(projectDir, sessionId, options)
  // At least one: the primary covers the first task, but a pool of zero would
  // queue forever if a second task ever arrived.
  const maxWorkers = Math.max(1, resolveConcurrencyConfig().maxConcurrentWorkers - 1)

  const pool = new WorkerPool<SessionWorker>({
    maxWorkers,
    // A worker is held for a task's whole run; keep one warm for the next task
    // and no more.
    maxIdle: maxWorkers > 0 ? 1 : 0,
    launch: async () => {
      const session = await launchSandboxSession(projectDir, sessionId, options)
      return {
        session,
        callTool: (tool, args) => session.handle.callTool(tool, args),
        close: () => session.close(),
      }
    },
  })

  interface Reservation {
    session: Promise<SandboxSession>
    /** The lease behind a pooled session; absent for the primary. */
    lease?: WorkerLease<SessionWorker>
    released: boolean
  }

  const reservations = new Map<string, Reservation>()
  let primaryInUse = false

  const reserve = (): Reservation => {
    if (!primaryInUse) {
      primaryInUse = true
      return { session: Promise.resolve(primary), released: false }
    }
    const reservation: Reservation = { session: null as never, released: false }
    reservation.session = pool.acquire().then(lease => {
      reservation.lease = lease
      return lease.worker.session
    })
    return reservation
  }

  const release = (reservation: Reservation, taskId: string): void => {
    if (reservation.released) return
    reservation.released = true
    void reservation.session.then(
      session => {
        // Drop the task's scoped permissions before anyone else can use this
        // worker — otherwise the next task inherits them.
        session.releaseTask(taskId)
        if (reservation.lease) reservation.lease.release()
        else primaryInUse = false
      },
      () => {
        if (reservation.lease) reservation.lease.markDead('session failed to start')
        else primaryInUse = false
      },
    )
  }

  return {
    handle: primary.handle,
    report: primary.report,
    setTaskPermissions: lookup => primary.setTaskPermissions(lookup),
    setOnMutate: fn => primary.setOnMutate(fn),

    handleForTask: (taskId, lookup, onMutate) => {
      const existing = reservations.get(taskId)
      const reservation = existing ?? reserve()
      if (!existing) reservations.set(taskId, reservation)

      let scoped: LaunchHandle | null = null
      return {
        callTool: async (tool, args) => {
          // Checked on *every* call, not just the first: once this task is
          // released its worker may belong to another task, and a stale handle
          // must not keep writing through it.
          if (reservation.released) {
            throw new Error(`Sandbox worker for task ${taskId} is no longer available`)
          }
          if (!scoped) {
            const ready = await reservation.session
            // The release may have landed while the session was starting.
            if (reservation.released) {
              throw new Error(`Sandbox worker for task ${taskId} is no longer available`)
            }
            scoped = ready.handleForTask(taskId, lookup, onMutate)
          }
          return scoped.callTool(tool, args)
        },
      }
    },

    releaseTask: taskId => {
      const reservation = reservations.get(taskId)
      if (!reservation) return
      reservations.delete(taskId)
      release(reservation, taskId)
    },

    close: () => {
      for (const [taskId, reservation] of reservations) release(reservation, taskId)
      reservations.clear()
      primary.close()
      void pool.drain()
    },
  }
}
