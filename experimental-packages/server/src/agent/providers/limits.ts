// Deadlines shared by every provider.
//
// Without these a stalled response is unrecoverable: the agent loops await a
// stream that never produces another chunk, the project sits in `running`
// forever, and nothing — not even projects.stop — can free it.

/** Ceiling on a single request, connection through final chunk. */
export const REQUEST_TIMEOUT_MS = Number(process.env.VAJRA_LLM_TIMEOUT_MS) || 600_000

/** Ceiling on the gap between two chunks of a stream. */
export const STREAM_IDLE_TIMEOUT_MS = Number(process.env.VAJRA_LLM_STREAM_IDLE_MS) || 120_000

/**
 * Wrap a stream so it fails if no chunk arrives within `idleMs`, calling
 * `onStall` (to abort the underlying request) before it throws.
 *
 * An overall request timeout is not enough on its own: a provider can hold a
 * connection open indefinitely while trickling nothing, and the SDK's own
 * timeout only covers establishing the response.
 */
export async function* withIdleTimeout<T>(
  stream: AsyncIterable<T>,
  label: string,
  onStall: () => void,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} stream stalled: no data for ${idleMs}ms`)),
        idleMs,
      )
    })

    let result: IteratorResult<T>
    try {
      result = await Promise.race([iterator.next(), stalled])
    } catch (err) {
      onStall()
      throw err
    } finally {
      clearTimeout(timer)
    }

    if (result.done) return
    yield result.value
  }
}

/**
 * An AbortSignal that fires when the caller's signal does, or when the
 * request deadline passes — whichever comes first.
 */
export function requestAbort(callerSignal?: AbortSignal): {
  controller: AbortController
  dispose: () => void
} {
  const controller = new AbortController()

  const timer = setTimeout(
    () => controller.abort(new Error(`Request exceeded ${REQUEST_TIMEOUT_MS}ms`)),
    REQUEST_TIMEOUT_MS,
  )

  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  if (callerSignal?.aborted) onCallerAbort()

  return {
    controller,
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    },
  }
}
