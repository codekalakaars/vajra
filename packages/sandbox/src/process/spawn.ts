// Spawning and driving a kernel-confined agent process.
//
// One call, `spawnAgent`, forks a worker that applies Landlock to itself
// before touching anything, then answers tool calls over IPC. Everything the
// caller used to assemble by hand — the fork, the env allowlist, callId
// bookkeeping, the report/ready race, the restart budget, stderr capture,
// per-task scoping, the worker pool — lives here.
//
// The caller supplies policy (from @codekalakaars/vajra-sandbox) and nothing
// else. The tools a worker can call are the ones this package ships, so there
// is one implementation of "what a confined agent may do" rather than one per
// call site.

import { fork, type ChildProcess } from 'node:child_process'
import { freezeTree, thawTree } from './freeze.js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildLaunchJob,
  createSandboxConfig,
  loadSandboxConfig,
  type LaunchJob,
  type SandboxConfig,
} from '../index.js'
import { resolveConcurrencyConfig, WorkerPool, type PoolWorker, type WorkerLease } from '../index.js'
import type { LaunchHandle } from './tools.js'
import { normalizeProjectPath, type TaskFilePermissions } from './task-permissions.js'

export interface SandboxReport {
  enforced: boolean
  mechanism: string
  warnings: string[]
}

/** How much of a worker's own output is worth keeping. */
const WORKER_NOISE_LINES = 20

/** A running confined agent, and the handles that scope calls to it. */
export interface Agent {
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
  /**
   * Freeze the worker serving `taskId`, and every command it is running, until
   * `resumeTask`. Calls made meanwhile wait rather than fail. Returns false when
   * no worker is serving the task yet, so there was nothing to freeze.
   */
  pauseTask: (taskId: string) => boolean
  /** Undo `pauseTask`. Safe to call for a task that is not paused. */
  resumeTask: (taskId: string) => void
  close: () => void
}

export interface SpawnAgentOptions {
  /** Proceed on a Linux kernel with no Landlock (pre-5.13). */
  allowUnenforced?: boolean
  /** Fail instead of returning an agent when the platform cannot enforce. */
  requireEnforced?: boolean
  timeoutMs?: number
  /**
   * Called for each line the worker writes to its own stdout or stderr.
   *
   * The alternative was writing it to the terminal, which is what this
   * arrangement exists to stop: the process that forks a worker is often
   * painting a full-screen TUI, and raw bytes from a child land in the middle of
   * the frame. The host's job is to put the line somewhere the user is actually
   * looking — for Vajra, the transcript.
   */
  onWorkerOutput?: (line: string) => void
  /**
   * Total Workers this run may have alive at once, primary included. Defaults to
   * `resolveConcurrencyConfig().maxConcurrentWorkers`.
   *
   * The pool is the hard ceiling on real parallelism: a task that holds a slot
   * here and no model round of its own is not running in parallel with anything,
   * however high the scheduler's own limit is. So the number a run is arranged by
   * has to reach the pool, not just the scheduler.
   */
  maxWorkers?: number
  /**
   * Pooled Workers kept warm between tasks, so the next task does not pay a fork.
   * Defaults to 1 — a worker is held for a task's whole run, and one spare is
   * enough to cover the gap. 0 pays the fork on every task.
   */
  maxIdleWorkers?: number
}

// The worker inherits only what it needs to find and run a Node interpreter.
// Anything else in the parent environment — the API key above all — must not
// cross the boundary. Note there is no SystemRoot/USERPROFILE here: the worker
// is Linux-only.
const WORKER_ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV'] as const

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
    // CLI UX: honour an explicit --allow-unenforced on a host with no Landlock
    // (a kernel older than 5.13) rather than hard-failing, as long as the user
    // has expressed no opinion in the config itself.
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
 * Spawn one kernel-confined agent and wait for it to report whether the
 * sandbox took. Throws if the worker refuses to start, if `applySandbox` fails,
 * or if `requireEnforced` is set and confinement is only partial.
 *
 * Resolves once the worker has applied Landlock to itself — never before. A
 * returned `Agent` is therefore already confined; a tool call on it cannot
 * escape the policy regardless of what the tool does.
 */
export async function spawnAgent(
  projectDir: string,
  sessionId: string,
  options: SpawnAgentOptions = {},
): Promise<Agent> {
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
  /** The worker process frozen by `pauseTask`, so close can thaw it before stopping it. */
  let frozenPid: number | null = null
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

  const onWorkerOutput = options.onWorkerOutput
  const startWorker = (): { child: ChildProcess; report: Promise<SandboxReport> } => {
    // Piped, not inherited. The worker is a child of a process that may be
    // painting a full-screen TUI, and an inherited fd is a straight line to the
    // terminal behind the renderer's back: one Node warning, one landlock
    // diagnostic, one stray console.log in a tool, and raw bytes land in the
    // middle of the frame. It looks like corruption, and it is unrecoverable
    // because the renderer has no idea anything else wrote there.
    //
    // A resume is where it shows up most often, because a resumed plan executes
    // without the user typing anything first — so the workers start printing
    // over a screen the user is still reading.
    const spawnedChild = fork(resolveWorkerPath(), [], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: buildWorkerEnv(),
    })
    /**
     * Anything the worker writes, buffered for the host to render.
     *
     * Buffered rather than forwarded because a line can arrive mid-frame, and a
     * per-chunk call would put one worker's stderr between two of another's.
     * Bounded because a chatty worker must not become a leak.
     */
    const workerNoise: string[] = []
    const flushNoise = (): void => {
      if (workerNoise.length === 0) return
      for (const line of workerNoise) onWorkerOutput?.(line)
      workerNoise.length = 0
    }
    const captureNoise = (stream: NodeJS.ReadableStream | null, label: string): void => {
      stream?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text === '') return
        if (workerNoise.length < WORKER_NOISE_LINES) {
          workerNoise.push(`${label}: ${text.slice(0, 400)}`)
          return
        }
        // One line too many: say so, and stop keeping them.
        workerNoise.length = 0
        workerNoise.push(`${label}: (more output suppressed)`)
      })
    }
    captureNoise(spawnedChild.stdout, 'worker stdout')
    captureNoise(spawnedChild.stderr, 'worker stderr')
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
      // The worker is gone, so this is the last chance to say what it said.
      flushNoise()
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
    // One worker process, so the task id only says which caller is asking: a
    // single agent serves one task at a time.
    pauseTask: () => {
      const pid = activeChild?.pid
      if (closed || pid === undefined) return false
      frozenPid = pid
      freezeTree(pid)
      return true
    },
    resumeTask: () => {
      if (frozenPid === null) return
      thawTree(frozenPid)
      frozenPid = null
    },
    close: () => {
      if (frozenPid !== null) {
        thawTree(frozenPid)
        frozenPid = null
      }
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

/** A pooled worker that remembers the agent it drives. */
interface AgentWorker extends PoolWorker {
  agent: Agent
}

/**
 * A pool of confined agents, one per in-flight task.
 *
 * The point is blast radius. With one shared worker, a single OOM or native
 * fault fails every in-flight task at once: the worker respawns, but the calls
 * already in flight on the dead process are gone, and so are the tasks that
 * were waiting on them. Giving each task its own worker means a crash costs one
 * task.
 *
 * The pool implements the same `Agent` surface as `spawnAgent`, so admission,
 * permission scoping and reporting work exactly as before with one of the two.
 * Per-task scoping is not weakened either: each task still gets `handleForTask`
 * on its own agent, so a worker is never shared with another task while either
 * of them is running.
 *
 * Workers are created lazily, so a single-task run forks exactly one worker as
 * before. `handleForTask` is synchronous by contract, so a reservation can be
 * an agent that is still starting; the handle it returns awaits that agent on
 * first use.
 */
export async function spawnAgentPool(
  projectDir: string,
  sessionId: string,
  options: SpawnAgentOptions = {},
): Promise<Agent> {
  // The primary session backs the session-scope handle (planning, rollback) and
  // the first task, so nothing is forked that would not have been before.
  const primary = await spawnAgent(projectDir, sessionId, options)
  // At least one: the primary covers the first task, but a pool of zero would
  // queue forever if a second task ever arrived.
  const totalWorkers = Math.max(
    1,
    Math.floor(options.maxWorkers ?? resolveConcurrencyConfig().maxConcurrentWorkers),
  )
  const maxWorkers = Math.max(1, totalWorkers - 1)

  const pool = new WorkerPool<AgentWorker>({
    maxWorkers,
    // A worker is held for a task's whole run; keep one warm for the next task
    // and no more.
    maxIdle: Math.max(0, Math.floor(options.maxIdleWorkers ?? 1)),
    launch: async () => {
      const agent = await spawnAgent(projectDir, sessionId, options)
      return {
        agent,
        callTool: (tool, args) => agent.handle.callTool(tool, args),
        close: () => agent.close(),
      }
    },
  })

  interface Reservation {
    agent: Promise<Agent>
    /** The lease behind a pooled agent; absent for the primary. */
    lease?: WorkerLease<AgentWorker>
    released: boolean
    /** Set while the task is paused; the agent it resolved to, once frozen. */
    paused: boolean
    frozen?: Agent
  }

  const reservations = new Map<string, Reservation>()
  let primaryInUse = false

  const reserve = (): Reservation => {
    if (!primaryInUse) {
      primaryInUse = true
      return { agent: Promise.resolve(primary), released: false, paused: false }
    }
    const reservation: Reservation = { agent: null as never, released: false, paused: false }
    reservation.agent = pool.acquire().then(lease => {
      reservation.lease = lease
      return lease.worker.agent
    })
    return reservation
  }

  /** Thaw whatever a paused reservation froze. */
  const thaw = (reservation: Reservation, taskId: string): void => {
    reservation.paused = false
    reservation.frozen?.resumeTask(taskId)
    reservation.frozen = undefined
  }

  const release = (reservation: Reservation, taskId: string): void => {
    if (reservation.released) return
    // A frozen worker must not go back to the pool, or close, still stopped.
    thaw(reservation, taskId)
    reservation.released = true
    void reservation.agent.then(
      agent => {
        // Drop the task's scoped permissions before anyone else can use this
        // worker — otherwise the next task inherits them.
        agent.releaseTask(taskId)
        if (reservation.lease) reservation.lease.release()
        else primaryInUse = false
      },
      () => {
        if (reservation.lease) reservation.lease.markDead('agent failed to start')
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
            const ready = await reservation.agent
            // The release may have landed while the agent was starting.
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

    // The worker is frozen as soon as the reservation has one. A task still
    // waiting for a worker to start has nothing to freeze yet; it is frozen the
    // moment its worker arrives, unless it was resumed first.
    pauseTask: taskId => {
      const reservation = reservations.get(taskId)
      if (!reservation || reservation.released || reservation.paused) return false
      reservation.paused = true
      void reservation.agent.then(
        agent => {
          if (!reservation.paused || reservation.released) return
          if (agent.pauseTask(taskId)) reservation.frozen = agent
        },
        () => {},
      )
      return true
    },

    resumeTask: taskId => {
      const reservation = reservations.get(taskId)
      if (reservation) thaw(reservation, taskId)
    },

    close: () => {
      for (const [taskId, reservation] of reservations) release(reservation, taskId)
      reservations.clear()
      primary.close()
      void pool.drain()
    },
  }
}
