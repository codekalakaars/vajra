// Worker pool for parallel task execution.
//
// Manages a pool of sandboxed worker processes with:
// - Concurrency limiting (semaphore)
// - Worker reuse (recycle workers between tasks)
// - Health checks (heartbeat pings)
// - Idle timeout (destroy idle workers after N ms)
// - Graceful shutdown

import type { LaunchJob, LaunchHandle, SandboxReport, ProjectLauncher } from './manager.js'
import type { ConcurrencyConfig } from '@codekalakaars/vajra-sandbox'
import { resolveConcurrencyConfig } from '@codekalakaars/vajra-sandbox'
import { cpus, totalmem, freemem } from 'node:os'

interface PooledWorker {
  /** Identifies this worker, not its project — several workers share a project. */
  id: number
  handle: LaunchHandle
  job: LaunchJob
  lastUsedAt: number
  idleTimer?: ReturnType<typeof setTimeout>
}

export type WorkerPoolConfig = ConcurrencyConfig

export interface WorkerPoolStats {
  active: number
  idle: number
  pending: number
  /** Current adaptive max concurrent workers */
  adaptiveMax: number
  /** System CPU usage (0-1) */
  cpuUsage: number
  /** System memory usage (0-1) */
  memoryUsage: number
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
  /** Workers currently in use (checked out), keyed by worker id. */
  private active = new Map<number, PooledWorker>()

  /** Source of worker ids. Keying `active` by projectId, as this once did,
   * silently dropped every worker after the first: tasks in one project all
   * share a projectId, so each checkout overwrote the previous entry and the
   * evicted worker was never stopped and never gave its slot back. */
  private nextWorkerId = 1

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

  /** Adaptive concurrency timer */
  private adaptiveTimer?: ReturnType<typeof setInterval>

  /** Current adaptive max concurrent workers */
  private adaptiveMax: number

  /** System metrics */
  private cpuUsage = 0
  private memoryUsage = 0

  private config: Required<WorkerPoolConfig>
  private launcher: ProjectLauncher

  constructor(
    config: Partial<WorkerPoolConfig>,
    launcher: ProjectLauncher,
  ) {
    this.config = resolveConcurrencyConfig(config)
    this.launcher = launcher
    this.availableSlots = this.config.maxConcurrentWorkers
    this.adaptiveMax = this.config.maxConcurrentWorkers

    // Start adaptive monitoring if enabled
    if (this.config.adaptiveConcurrency) {
      this.startAdaptiveMonitoring()
    }
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
      worker.job = job
      this.active.set(worker.id, worker)
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
    for (const worker of this.active.values()) {
      if (worker.handle === handle) {
        pooled = worker
        this.active.delete(worker.id)
        break
      }
    }

    if (!pooled) return

    if (!reuse || this.idle.length >= this.config.maxIdleWorkers) {
      // Destroy the worker
      handle.stop()
      this.availableSlots = Math.min(this.availableSlots + 1, this.config.maxConcurrentWorkers)
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
    // Stop adaptive monitoring
    this.stopAdaptiveMonitoring()

    // Clear all idle timers
    for (const timer of this.idleTimers) {
      clearTimeout(timer)
    }
    this.idleTimers = []

    // Stop all idle workers
    for (const worker of this.idle) {
      worker.handle.stop()
    }
    this.idle = []

    // Stop all active workers
    for (const worker of this.active.values()) {
      worker.handle.stop()
    }
    this.active.clear()

    // Reset capacity. Leaving this at zero left a drained pool permanently
    // unusable, and a stopped project can be resumed.
    this.availableSlots = this.config.maxConcurrentWorkers

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
      adaptiveMax: this.adaptiveMax,
      cpuUsage: this.cpuUsage,
      memoryUsage: this.memoryUsage,
    }
  }

  /**
   * Start adaptive concurrency monitoring.
   * Checks system resources every 5 seconds and adjusts max workers.
   */
  private startAdaptiveMonitoring(): void {
    this.adaptiveTimer = setInterval(() => {
      this.updateSystemMetrics()
      this.adjustConcurrency()
    }, 5000)
  }

  /** Previous CPU info for delta calculation */
  private prevCpuInfo?: { idle: number; total: number }

  /**
   * Update system CPU and memory usage metrics.
   */
  private updateSystemMetrics(): void {
    // Calculate CPU usage as delta between snapshots (not cumulative since boot)
    const cpusInfo = cpus()
    let totalIdle = 0
    let totalTick = 0
    
    for (const cpu of cpusInfo) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times]
      }
      totalIdle += cpu.times.idle
    }
    
    if (this.prevCpuInfo) {
      const idleDelta = totalIdle - this.prevCpuInfo.idle
      const totalDelta = totalTick - this.prevCpuInfo.total
      this.cpuUsage = totalDelta > 0 ? 1 - (idleDelta / totalDelta) : 0
    }
    this.prevCpuInfo = { idle: totalIdle, total: totalTick }

    // Calculate memory usage
    const totalMem = totalmem()
    const freeMem = freemem()
    this.memoryUsage = 1 - (freeMem / totalMem)
  }

  /**
   * Adjust max concurrent workers based on system metrics.
   */
  private adjustConcurrency(): void {
    if (!this.config.adaptiveConcurrency) return

    const baseMax = this.config.maxConcurrentWorkers
    const minMax = this.config.minConcurrentWorkers

    // Reduce workers if system is under heavy load
    let targetMax = baseMax

    // CPU-based adjustment
    if (this.cpuUsage > this.config.maxCpuUsage) {
      const cpuOverload = (this.cpuUsage - this.config.maxCpuUsage) / (1 - this.config.maxCpuUsage)
      targetMax = Math.max(minMax, Math.floor(baseMax * (1 - cpuOverload * 0.5)))
    }

    // Memory-based adjustment
    if (this.memoryUsage > this.config.maxMemoryUsage) {
      const memOverload = (this.memoryUsage - this.config.maxMemoryUsage) / (1 - this.config.maxMemoryUsage)
      targetMax = Math.max(minMax, Math.floor(targetMax * (1 - memOverload * 0.5)))
    }

    // Apply adjustment with smooth transition (max 1 worker change per cycle)
    if (targetMax < this.adaptiveMax) {
      this.adaptiveMax = Math.max(targetMax, this.adaptiveMax - 1)
    } else if (targetMax > this.adaptiveMax) {
      this.adaptiveMax = Math.min(targetMax, this.adaptiveMax + 1)
    }

    // Update available slots if we reduced capacity
    if (this.adaptiveMax < this.availableSlots + this.active.size) {
      this.availableSlots = Math.max(0, this.adaptiveMax - this.active.size)
    }
  }

  /**
   * Stop adaptive monitoring.
   */
  private stopAdaptiveMonitoring(): void {
    if (this.adaptiveTimer) {
      clearInterval(this.adaptiveTimer)
      this.adaptiveTimer = undefined
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
      id: this.nextWorkerId++,
      handle,
      job,
      lastUsedAt: Date.now(),
    }

    this.active.set(pooled.id, pooled)

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
}
