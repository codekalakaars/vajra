import type { PauseGate } from '../manager/pause.js'

/**
 * One attempt's clock and its single abort signal.
 *
 * The signal combines the session's and the run's deadline, and everything the
 * attempt waits on is handed it, so whichever of the two ends the attempt (a
 * person pressing Ctrl-C, or the clock) the attempt is judged the same way.
 *
 * The deadline is enforced wherever the attempt can still be interrupted: before
 * each round, before each group of tool calls, and as the ceiling on a
 * validation command. A provider request already in flight is cut by the signal
 * `streamChatCompletion` passes the SDK as a request option.
 *
 * The clock stops while the scheduler has the Worker paused: a pause is the
 * scheduler's decision, not the task's slowness.
 */
export interface AttemptClock {
  /** The session's signal and the deadline, as one. */
  signal: AbortSignal
  /** Milliseconds left before the deadline, counting only time the Worker was allowed to run. */
  remainingMs(): number
  /**
   * Whether the attempt ran out of time, as opposed to the session ending.
   *
   * A timeout is a failed attempt rather than a silent success: leaving the loop
   * on the abort and carrying on to validation would report a task done having
   * done nothing.
   */
  outOfTime(): boolean
  timedOutMessage(): string
  /**
   * Hold here while the scheduler has this Worker paused. The session ending
   * opens it too: a paused Worker must still be able to notice an interrupt.
   */
  waitWhilePaused(): Promise<void>
  /** Stop the timer. Call on every exit path. */
  dispose(): void
}

export function createAttemptClock(input: {
  timeoutSec: number
  gate?: PauseGate
  signal?: AbortSignal
}): AttemptClock {
  const { timeoutSec, gate, signal } = input
  const deadlineMs = timeoutSec * 1000
  const startedAt = Date.now()
  const activeMs = (): number => Date.now() - startedAt - (gate?.pausedMs() ?? 0)
  const controller = new AbortController()
  const deadline = controller.signal
  let timer: ReturnType<typeof setTimeout> | null = null

  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (deadline.aborted || gate?.paused) return
    timer = setTimeout(
      () => controller.abort(new DOMException('Attempt timed out', 'TimeoutError')),
      Math.max(0, deadlineMs - activeMs()),
    )
    timer.unref?.()
  }
  arm()
  gate?.onChange(arm)

  return {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    remainingMs: () => deadlineMs - activeMs(),
    outOfTime: () => deadline.aborted,
    timedOutMessage: () => `Attempt timed out after ${timeoutSec}s.`,
    waitWhilePaused: async () => {
      if (!gate?.paused || signal?.aborted) return
      await new Promise<void>(resolve => {
        const done = (): void => {
          signal?.removeEventListener('abort', done)
          resolve()
        }
        signal?.addEventListener('abort', done, { once: true })
        void gate.wait().then(done)
      })
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
    },
  }
}
