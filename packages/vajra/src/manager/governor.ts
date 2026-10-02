import { cpus, freemem } from 'node:os'
import { readFileSync } from 'node:fs'
import { descendants } from '@codekalakaars/vajra-sandbox'

/**
 * How many Workers the machine can carry, measured rather than configured.
 *
 * There is no Worker count. A task is admitted while the CPU has headroom and
 * there is RAM for one more Worker; when the CPU saturates, the scheduler
 * pauses its lowest-priority Worker, one per sample, and resumes them as the CPU
 * recovers. The governor only measures and answers; which task to pause is the
 * scheduler's call, because only it knows the plan.
 *
 * Only load that is ours counts. The Workers spend most of their time waiting on
 * the model, so a machine that is saturated by other programs is saturated by
 * them: pausing a Worker would not relieve it, only slow the run. The sampler
 * therefore also reads how much of the machine this process and everything it
 * started is using, and the governor throttles only when that is at least
 * `cpuOwnMin`.
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
  /**
   * The share of all cores used by this process and everything it started,
   * 0..1. Absent when the sampler cannot tell, which counts as all of it.
   */
  ownCpu?: number
}

export type Sampler = () => ResourceSample

export interface GovernorConfig {
  /** CPU share at or above which the scheduler pauses a Worker. */
  cpuPauseAt: number
  /** CPU share below which a paused Worker resumes, or a new one is admitted. */
  cpuResumeAt: number
  /**
   * The least share of the machine this run must be using for a busy CPU to be
   * its doing. Below it, a saturated machine is someone else's load: nothing is
   * paused and Workers keep starting.
   */
  cpuOwnMin: number
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

/** Clock ticks per second in /proc/<pid>/stat. 100 on every Linux kernel Vajra supports. */
const TICKS_PER_SECOND = 100

/** CPU ticks (user + system) a process has used so far, or null if it is gone. */
function processTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    // The command name is in parentheses and may contain spaces, so count from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(fields[11]) + Number(fields[12])
    return Number.isFinite(ticks) ? ticks : null
  } catch {
    return null
  }
}

/**
 * The machine's real readings. CPU is the busy share between two calls, so the
 * first call measures from the moment the sampler was made.
 */
export function systemSampler(): Sampler {
  let previous = cpuTimes()
  /** Each of our processes' ticks at the last reading, so only the new ones are counted. */
  let seen = new Map<number, number>()
  return () => {
    const current = cpuTimes()
    const total = current.total - previous.total
    const busy = current.busy - previous.busy
    previous = current

    // A process that appeared since the last reading counts in full: it did all
    // its work inside the interval. One that exited is simply absent.
    const now = new Map<number, number>()
    let ownTicks = 0
    for (const pid of [process.pid, ...descendants(process.pid)]) {
      const ticks = processTicks(pid)
      if (ticks === null) continue
      now.set(pid, ticks)
      ownTicks += Math.max(0, ticks - (seen.get(pid) ?? 0))
    }
    seen = now
    // `total` is milliseconds summed over every core, the same unit as the ticks below.
    const ownMs = (ownTicks * 1000) / TICKS_PER_SECOND

    return {
      cpu: total > 0 ? Math.min(1, Math.max(0, busy / total)) : 0,
      availableMemMb: availableMemMb(),
      ownCpu: total > 0 ? Math.min(1, Math.max(0, ownMs / total)) : 0,
    }
  }
}

/** What a run's readings added up to, for the result. */
export interface GovernorStats {
  samples: number
  /** The highest machine-wide CPU reading. */
  peakCpu: number
  /** The highest share of the machine this run itself used. */
  peakOwnCpu: number
  /** Readings at which a Worker would have been paused. */
  chokingSamples: number
  /** Readings at which the machine was busy but the load was not ours, so nothing was throttled. */
  externalLoadSamples: number
}

export class Governor {
  private latest: ResourceSample
  /** Workers admitted since the last reading, whose RAM it has not seen yet. */
  private admittedSinceSample = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly counts: GovernorStats = {
    samples: 0,
    peakCpu: 0,
    peakOwnCpu: 0,
    chokingSamples: 0,
    externalLoadSamples: 0,
  }
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
    const { counts, latest } = this
    counts.samples++
    counts.peakCpu = Math.max(counts.peakCpu, latest.cpu)
    counts.peakOwnCpu = Math.max(counts.peakOwnCpu, latest.ownCpu ?? 0)
    if (this.choking()) counts.chokingSamples++
    else if (latest.cpu >= this.config.cpuResumeAt) counts.externalLoadSamples++
    this.wake()
    return this.latest
  }

  stats(): GovernorStats {
    return { ...this.counts }
  }

  /** Whether the load on the machine is ours to relieve. A sampler that cannot tell counts as ours. */
  private ours(): boolean {
    const own = this.latest.ownCpu
    return own === undefined || own >= this.config.cpuOwnMin
  }

  get reading(): ResourceSample {
    return this.latest
  }

  /** CPU is saturated: the scheduler should pause a Worker. */
  choking(): boolean {
    return this.latest.cpu >= this.config.cpuPauseAt && this.ours()
  }

  /** CPU has room again, or is busy with something else: a paused Worker may resume. */
  relieved(): boolean {
    return this.latest.cpu < this.config.cpuResumeAt || !this.ours()
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

/**
 * The cap on Workers running at once: none, unless `--concurrency` asks for one.
 *
 * Without a cap the machine decides — a task starts while CPU and RAM have room
 * for it, and the lowest-priority Worker is paused while the CPU is saturated
 * (`governor.ts`). The flag stays as an explicit ceiling for a user who
 * wants one, clamped to >= 1 so a zero or negative value cannot freeze the
 * scheduler.
 */
export function resolveMaxWorkers(override?: number): number {
  if (override === undefined || !Number.isFinite(override)) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.floor(override))
}
