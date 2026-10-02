/**
 * A Worker's pause switch, as the Worker's own loop sees it.
 *
 * Freezing the sandbox stops the commands a Worker runs; it cannot stop the
 * Worker's model loop, which lives in this process. The gate is that half: the
 * loop waits on it before each model round and each group of tool calls, so a
 * paused Worker neither asks the model for more nor starts more work.
 *
 * It also keeps the time spent paused, because a pause is the scheduler's
 * decision and not the task's slowness: the attempt's deadline stops while the
 * gate is shut.
 */
export class PauseGate {
  private shutAt: number | null = null
  private pausedTotalMs = 0
  private waiters: Array<() => void> = []
  private listeners: Array<(paused: boolean) => void> = []

  constructor(private readonly now: () => number = Date.now) {}

  get paused(): boolean {
    return this.shutAt !== null
  }

  pause(): void {
    if (this.shutAt !== null) return
    this.shutAt = this.now()
    for (const listener of this.listeners) listener(true)
  }

  resume(): void {
    if (this.shutAt === null) return
    this.pausedTotalMs += this.now() - this.shutAt
    this.shutAt = null
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
    for (const listener of this.listeners) listener(false)
  }

  /** Resolves at once when open; otherwise when `resume` is called. */
  wait(): Promise<void> {
    if (this.shutAt === null) return Promise.resolve()
    return new Promise(resolve => this.waiters.push(resolve))
  }

  /** Total time paused so far, including a pause still in progress. */
  pausedMs(): number {
    return this.pausedTotalMs + (this.shutAt === null ? 0 : this.now() - this.shutAt)
  }

  /** Called with `true` on pause and `false` on resume. */
  onChange(listener: (paused: boolean) => void): void {
    this.listeners.push(listener)
  }
}
