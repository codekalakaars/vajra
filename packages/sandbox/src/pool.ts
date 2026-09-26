import { resolveConcurrencyConfig, type ConcurrencyConfig } from './resources.js'

/**
 * A worker process the pool can hand out. Deliberately minimal: the pool knows
 * how many workers exist and when to replace one, and nothing else. Whatever
 * launches the process — a forked sandbox, a container, a test fake — supplies
 * this shape, which is what keeps this file free of any launcher dependency.
 */
export interface PoolWorker {
  callTool(tool: string, args: unknown): Promise<unknown>
  close(): void | Promise<void>
}

export type PoolWorkerFactory = () => Promise<PoolWorker>

export interface WorkerPoolOptions<T extends PoolWorker = PoolWorker> {
  /** Hard cap on live workers. Defaults to `maxConcurrentWorkers` (4). */
  maxWorkers?: number
  /** Workers kept warm while idle. Defaults to `maxIdleWorkers` (1). */
  maxIdle?: number
  /** Destroy a worker idle this long. Defaults to `idleTimeoutMs` (60s). */
  idleTimeoutMs?: number
  /** For tests: never cache idle workers. */
  keepIdle?: boolean
  launch: () => Promise<T>
}

export interface PoolStats {
  /** Checked out by a caller. */
  active: number
  /** Warm and available. */
  idle: number
  /** Forks in flight. */
  starting: number
  /** Callers waiting for a slot. */
  waiting: number
  /** Workers created since construction — the number that proves isolation. */
  created: number
}

interface IdleWorker<T extends PoolWorker = PoolWorker> {
  worker: T
  timer: ReturnType<typeof setTimeout> | null
}

interface Waiter<T extends PoolWorker = PoolWorker> {
  resolve: (lease: WorkerLease<T>) => void
  reject: (error: Error) => void
}

/** A checked-out worker. Call `release()` when done; `callTool` until then. */
export interface WorkerLease<T extends PoolWorker = PoolWorker> {
  readonly id: number
  /** The worker behind this lease — how a caller reaches its own wrapper state. */
  readonly worker: T
  callTool(tool: string, args: unknown): Promise<unknown>
  /**
   * Report the worker as unrecoverable. It is closed, dropped, and replaced on
   * the next acquire — and, critically, every *other* lease is untouched. That
   * is the whole point of the pool: a crash costs one task's calls, not all of
   * them.
   */
  markDead(reason?: string): void
  release(): void
}

const REASON_CLOSED = 'Worker pool is draining'

/**
 * A bounded pool of interchangeable worker processes.
 *
 * Concurrency is why this exists: tasks run in parallel, and a single shared
 * worker means one crash fails every in-flight task at once. With one worker per
 * in-flight task, the blast radius is one task.
 *
 * Deliberately *not* a copy of the server's original `WorkerPool`: that one
 * reused workers keyed on a permission hash and re-derived a permission identity
 * to keep task A's sandbox away from task B. Per-task handle scoping already
 * guarantees that here, so the reuse key would be dead weight — and reusing a
 * worker across tasks is exactly what a pool must *not* do, since it would undo
 * the isolation this is for. Workers are therefore never shared between
 * concurrent leases; they are only ever reused after a release.
 */
export class WorkerPool<T extends PoolWorker = PoolWorker> {
  private readonly maxWorkers: number
  private readonly maxIdle: number
  private readonly idleTimeoutMs: number
  private readonly keepIdle: boolean
  private readonly launch: () => Promise<T>

  private readonly idle: IdleWorker<T>[] = []
  private readonly active = new Map<number, WorkerLease<T>>()
  private readonly starting = new Set<Promise<T>>()
  private readonly waiters: Waiter<T>[] = []
  private nextId = 1
  private createdCount = 0
  private closed = false

  constructor(options: WorkerPoolOptions<T>) {
    const config: ConcurrencyConfig = resolveConcurrencyConfig({
      maxConcurrentWorkers: options.maxWorkers,
      maxIdleWorkers: options.maxIdle,
      idleTimeoutMs: options.idleTimeoutMs,
    })
    this.maxWorkers = config.maxConcurrentWorkers
    this.keepIdle = options.keepIdle ?? true
    this.maxIdle = this.keepIdle ? config.maxIdleWorkers : 0
    this.idleTimeoutMs = config.idleTimeoutMs
    this.launch = options.launch
  }

  stats(): PoolStats {
    return {
      active: this.active.size,
      idle: this.idle.length,
      starting: this.starting.size,
      waiting: this.waiters.length,
      created: this.createdCount,
    }
  }

  /** Take a worker, forking one if none is warm and the cap allows it. */
  async acquire(): Promise<WorkerLease<T>> {
    if (this.closed) throw new Error(REASON_CLOSED)

    const warm = this.takeIdle()
    if (warm) return this.lease(warm)

    if (this.active.size + this.starting.size < this.maxWorkers) {
      return this.lease(await this.fork())
    }

    // At the cap: queue. Handing the slot straight to the first waiter is what
    // keeps a released worker from being stolen by a fresh caller.
    return new Promise<WorkerLease<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  /**
   * Destroy every worker and reject anyone waiting. A launch already in flight
   * is closed as soon as it lands, so a fork racing a drain cannot leak.
   */
  async drain(): Promise<void> {
    this.closed = true
    const pending = this.waiters.splice(0, this.waiters.length)
    for (const waiter of pending) waiter.reject(new Error(REASON_CLOSED))

    const warm = this.idle.splice(0, this.idle.length)
    for (const entry of warm) this.destroy(entry)

    const inFlight = [...this.starting]
    await Promise.allSettled(inFlight)
    const leftovers = this.idle.splice(0, this.idle.length)
    for (const entry of leftovers) this.destroy(entry)
  }

  private takeIdle(): T | null {
    const entry = this.idle.shift()
    if (!entry) return null
    if (entry.timer) clearTimeout(entry.timer)
    return entry.worker
  }

  private async fork(): Promise<T> {
    const pending = (async () => {
      const worker = await this.launch()
      this.createdCount++
      // A drain may have landed while this fork was in the air.
      if (this.closed) {
        await worker.close()
        throw new Error(REASON_CLOSED)
      }
      return worker
    })()

    this.starting.add(pending)
    try {
      return await pending
    } finally {
      this.starting.delete(pending)
    }
  }

  private lease(worker: T): WorkerLease<T> {
    const id = this.nextId++
    let released = false
    let dead = false

    const close = (): void => {
      if (dead) return
      dead = true
      try {
        void worker.close()
      } catch {
        // A worker that cannot be closed is already gone; nothing to do.
      }
    }

    const lease: WorkerLease<T> = {
      id,
      worker,
      callTool: (tool, args) => {
        if (released) return Promise.reject(new Error(`Lease ${id} was already released`))
        if (dead) return Promise.reject(new Error(`Worker ${id} is no longer available`))
        return worker.callTool(tool, args)
      },
      markDead: reason => {
        if (released) return
        close()
        // Free the slot now so a replacement can start without waiting for a
        // release that may never come.
        this.active.delete(id)
        void reason
        this.pump()
      },
      release: () => {
        if (released) return
        released = true
        this.active.delete(id)
        if (dead || this.closed) {
          if (!dead) close()
          this.pump()
          return
        }
        this.park(worker)
        this.pump()
      },
    }

    this.active.set(id, lease)
    return lease
  }

  private park(worker: T): void {
    if (!this.keepIdle || this.idle.length >= this.maxIdle) {
      try {
        void worker.close()
      } catch {
        // Already gone.
      }
      return
    }
    const entry: IdleWorker<T> = { worker, timer: null }
    entry.timer = setTimeout(() => {
      const at = this.idle.indexOf(entry)
      if (at >= 0) {
        this.idle.splice(at, 1)
        this.destroy(entry)
      }
    }, this.idleTimeoutMs)
    entry.timer.unref?.()
    this.idle.push(entry)
  }

  private destroy(entry: IdleWorker<T>): void {
    if (entry.timer) clearTimeout(entry.timer)
    try {
      void entry.worker.close()
    } catch {
      // Already gone.
    }
  }

  /** Hand freed capacity to whoever is queued. */
  private pump(): void {
    while (this.waiters.length > 0) {
      const warm = this.takeIdle()
      if (warm) {
        this.waiters.shift()!.resolve(this.lease(warm))
        continue
      }
      if (this.active.size + this.starting.size < this.maxWorkers) {
        const waiter = this.waiters.shift()!
        this.fork().then(
          worker => waiter.resolve(this.lease(worker)),
          error => waiter.reject(error instanceof Error ? error : new Error(String(error))),
        )
        continue
      }
      return
    }
  }
}
