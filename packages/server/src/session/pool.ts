// Worker pool for parallel task execution.
//
// Manages a pool of sandboxed worker processes with:
// - Concurrency limiting (semaphore)
// - Worker reuse (recycle workers between tasks)
// - Health checks (heartbeat pings)
// - Idle timeout (destroy idle workers after N ms)
// - Graceful shutdown

import type { LaunchJob, LaunchHandle, SandboxReport, SessionLauncher } from './manager.js'
import type { ConcurrencyConfig } from '@vajra/sandbox'
import { resolveConcurrencyConfig } from '@vajra/sandbox'

interface PooledWorker {
  handle: LaunchHandle
  job: LaunchJob
  lastUsedAt: number
  idleTimer?: ReturnType<typeof setTimeout>
}

export interface WorkerPoolConfig {
  maxConcurrentWorkers: number
  maxIdleWorkers: number
  idleTimeoutMs: number
  healthCheckIntervalMs: number
}

export interface WorkerPoolStats {
  active: number
  idle: number
  pending: number
}

/**
 * Pool of sandboxed worker processes with concurrency control.
 *
 * Usage:
 *   const pool = new WorkerPool(config, launcher)
 *   const handle = await pool.acquire(job)
 *   try {
 *     await handle.callTool('read_file', { path: 'src/index.ts' })
 *   } finally {
 *     pool.release(handle)  // return to pool for reuse
 *   }
 */
export class WorkerPool {
  /** Workers currently in use (checked out). */
  private active = new Map<string, PooledWorker>()

  /** Workers available for reuse (idle). */
  private idle: PooledWorker[] = []

  /** Callers waiting for a worker to become available. */
  private waiters: Array<{
    resolve: (worker: PooledWorker | null) => void
    reject: (error: Error) => void
  }> = []

  /** Available slot count (not tracked by idle pool alone). */
  private availableSlots: number

  /** Timers for idle worker cleanup. */
  private idleTimers: ReturnType<typeof setTimeout>[] = []

  private config: Required<WorkerPoolConfig>
  private launcher: SessionLauncher

  constructor(
    config: Partial<WorkerPoolConfig>,
    launcher: SessionLauncher,
  ) {
    this.config = resolveConcurrencyConfig(config)
    this.launcher = launcher
    this.availableSlots = this.config.maxConcurrentWorkers
  }

  /**
   * Acquire a worker from the pool. Blocks if at capacity.
   *
   * If an idle worker exists with the same projectDir, it's reused.
   * Otherwise a new worker is forked.
   */
  async acquire(job: LaunchJob): Promise<LaunchHandle> {
    // Try to reuse an idle worker with same project
    const reuseIndex = this.idle.findIndex(
      (w) => w.job.projectDir === job.projectDir,
    )

    if (reuseIndex >= 0) {
      const worker = this.idle.splice(reuseIndex, 1)[0]
      this.clearIdleTimer(worker)
      this.active.set(job.sessionId, worker)
      return worker.handle
    }

    // If at capacity, wait for a slot
    if (this.availableSlots <= 0) {
      const worker = await this.waitForSlot()
      if (worker) {
        // Got an idle worker - stop it and fork new one for different project
        worker.handle.stop()
      }
      // Fork a new worker (either no idle worker or got null)
      return this.forkWorker(job)
    }

    // Fork a new worker
    this.availableSlots--
    return this.forkWorker(job)
  }

  /**
   * Release a worker back to the pool for reuse.
   *
   * If reuse=false, the worker is destroyed immediately.
   */
  release(handle: LaunchHandle, reuse = true): void {
    // Find and remove from active
    let pooled: PooledWorker | undefined
    for (const [id, worker] of this.active) {
      if (worker.handle === handle) {
        pooled = worker
        this.active.delete(id)
        break
      }
    }

    if (!pooled) return

    if (!reuse || this.idle.length >= this.config.maxIdleWorkers) {
      // Destroy the worker
      handle.stop()
      this.availableSlots++
      this.notifyWaiter()
      return
    }

    // Return to idle pool
    pooled.lastUsedAt = Date.now()
    this.idle.push(pooled)
    this.startIdleTimer(pooled)
    this.notifyWaiter()
  }

  /**
   * Destroy all workers and reject pending acquire calls.
   */
  async drain(): Promise<void> {
    // Clear all idle timers
    for (const timer of this.idleTimers) {
      clearTimeout(timer)
    }
    this.idleTimers = []

    // Stop all idle workers
    for (const worker of this.idle) {
      this.clearHealthCheck(worker)
      worker.handle.stop()
    }
    this.idle = []

    // Stop all active workers
    for (const [, worker] of this.active) {
      this.clearHealthCheck(worker)
      worker.handle.stop()
    }
    this.active.clear()

    // Reset slot count
    this.availableSlots = 0

    // Reject all waiters
    for (const waiter of this.waiters) {
      waiter.reject(new Error('Worker pool drained'))
    }
    this.waiters = []
  }

  /**
   * Current pool statistics.
   */
  stats(): WorkerPoolStats {
    return {
      active: this.active.size,
      idle: this.idle.length,
      pending: this.waiters.length,
    }
  }

  // ---- Internal ----

  private async forkWorker(job: LaunchJob): Promise<LaunchHandle> {
    const handle = await this.launcher(
      job,
      (_report: SandboxReport) => {
        // Sandbox report callback - could be used for monitoring
      },
    )

    const pooled: PooledWorker = {
      handle,
      job,
      lastUsedAt: Date.now(),
    }

    this.startHealthCheck(pooled)
    this.active.set(job.sessionId, pooled)

    return handle
  }

  private waitForSlot(): Promise<PooledWorker | null> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  private notifyWaiter(): void {
    if (this.waiters.length === 0) return

    // If there's an idle worker, give it to the waiter
    const worker = this.idle.pop()
    if (worker) {
      const waiter = this.waiters.shift()!
      waiter.resolve(worker)
      return
    }

    // If there's a free slot (worker was destroyed), notify waiter with null
    // so it can fork a new worker
    if (this.availableSlots > 0) {
      this.availableSlots--
      const waiter = this.waiters.shift()!
      waiter.resolve(null)
    }
  }

  private startIdleTimer(worker: PooledWorker): void {
    const timer = setTimeout(() => {
      // Remove from idle pool and destroy
      const index = this.idle.indexOf(worker)
      if (index >= 0) {
        this.idle.splice(index, 1)
        this.clearHealthCheck(worker)
        worker.handle.stop()
        // Remove timer from idleTimers array
        const timerIndex = this.idleTimers.indexOf(timer)
        if (timerIndex >= 0) {
          this.idleTimers.splice(timerIndex, 1)
        }
      }
    }, this.config.idleTimeoutMs)

    worker.idleTimer = timer
    this.idleTimers.push(timer)
  }

  private clearIdleTimer(worker: PooledWorker): void {
    if (worker.idleTimer) {
      clearTimeout(worker.idleTimer)
      const index = this.idleTimers.indexOf(worker.idleTimer)
      if (index >= 0) {
        this.idleTimers.splice(index, 1)
      }
      worker.idleTimer = undefined
    }
  }

  private startHealthCheck(_worker: PooledWorker): void {
    // Health check is not yet implemented - placeholder for future use
  }

  private clearHealthCheck(_worker: PooledWorker): void {
    // Health check is not yet implemented - placeholder for future use
  }
}
