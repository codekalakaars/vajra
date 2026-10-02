import { cpus, freemem } from 'node:os'
import { readFileSync } from 'node:fs'

/**
 * How many Workers the machine can carry, measured rather than configured.
 *
 * There is no Worker count. A task is admitted while the CPU has headroom and
 * there is RAM for one more Worker; when the CPU saturates, the scheduler
 * pauses its lowest-priority Worker, one per sample, and resumes them as the CPU
 * recovers. The governor only measures and answers; which task to pause is the
 * scheduler's call, because only it knows the plan.
 *
 * CPU has two thresholds, not one. Pausing at 90% and admitting again at 89%
 * would admit the Worker that pushes it back over, every sample; the gap
 * between `cpuPauseAt` and `cpuResumeAt` is what keeps the run from flapping.
 */

/** One reading of the machine. */
export interface ResourceSample {
  /** Busy share of all cores since the previous reading, 0..1. */
  cpu: number
  /** RAM the kernel can hand out without swapping, in MB. */
  availableMemMb: number
}

export type Sampler = () => ResourceSample

export interface GovernorConfig {
  /** CPU share at or above which the scheduler pauses a Worker. */
  cpuPauseAt: number
  /** CPU share below which a paused Worker resumes, or a new one is admitted. */
  cpuResumeAt: number
  /** RAM that must stay free after admitting a Worker. */
  minFreeMemMb: number
  /** RAM one Worker is assumed to take, until the next reading shows what it did. */
  workerMemMb: number
  /** How often the machine is read. */
  resourceSampleMs: number
}

/** `MemAvailable` from /proc/meminfo; `os.freemem()` where it cannot be read. */
function availableMemMb(): number {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf-8'))
    if (match) return Number(match[1]) / 1024
  } catch {
    // Not Linux, or /proc is hidden: fall through.
  }
  // MemFree undercounts (it leaves out reclaimable cache), so this errs on the
  // side of admitting fewer Workers, never more.
  return freemem() / (1024 * 1024)
}

function cpuTimes(): { busy: number; total: number } {
  let busy = 0
  let total = 0
  for (const cpu of cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times
    busy += user + nice + sys + irq
    total += user + nice + sys + idle + irq
  }
  return { busy, total }
}

/**
 * The machine's real readings. CPU is the busy share between two calls, so the
 * first call measures from the moment the sampler was made.
 */
export function systemSampler(): Sampler {
  let previous = cpuTimes()
  return () => {
    const current = cpuTimes()
    const total = current.total - previous.total
    const busy = current.busy - previous.busy
    previous = current
    return {
      cpu: total > 0 ? Math.min(1, Math.max(0, busy / total)) : 0,
      availableMemMb: availableMemMb(),
    }
  }
}

export class Governor {
  private latest: ResourceSample
  /** Workers admitted since the last reading, whose RAM it has not seen yet. */
  private admittedSinceSample = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private tickWaiters: Array<() => void> = []

  constructor(
    readonly config: GovernorConfig,
    private readonly sampler: Sampler = systemSampler(),
  ) {
    // The system sampler's first reading covers the moment since it was made,
    // so the run starts with the CPU close to idle and the memory as it is now.
    this.latest = sampler()
  }

  /** Read the machine every `resourceSampleMs`, calling `onSample` after each reading. */
  start(onSample: () => void): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.sample()
      onSample()
    }, this.config.resourceSampleMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.wake()
  }

  /** Take a reading now. Exposed for the tests and for `start`. */
  sample(): ResourceSample {
    this.latest = this.sampler()
    this.admittedSinceSample = 0
    this.wake()
    return this.latest
  }

  get reading(): ResourceSample {
    return this.latest
  }

  /** CPU is saturated: the scheduler should pause a Worker. */
  choking(): boolean {
    return this.latest.cpu >= this.config.cpuPauseAt
  }

  /** CPU has room again: a paused Worker may resume. */
  relieved(): boolean {
    return this.latest.cpu < this.config.cpuResumeAt
  }

  /**
   * Whether one more Worker fits. Workers admitted since the last reading are
   * charged `workerMemMb` each, so a burst of ready tasks cannot all be admitted
   * against a reading taken before any of them started.
   */
  canAdmit(): boolean {
    if (!this.relieved()) return false
    const committed = (this.admittedSinceSample + 1) * this.config.workerMemMb
    return this.latest.availableMemMb - committed >= this.config.minFreeMemMb
  }

  noteAdmitted(): void {
    this.admittedSinceSample++
  }

  /** Resolves at the next reading, or when the governor stops. */
  nextSample(): Promise<void> {
    return new Promise(resolve => this.tickWaiters.push(resolve))
  }

  private wake(): void {
    const waiters = this.tickWaiters
    this.tickWaiters = []
    for (const wake of waiters) wake()
  }
}
