import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat'
import type { TokenUsage } from '../manager/ui.js'
import { modelInfo } from './catalog.js'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAiToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

/**
 * Reasoning effort. Sent as the OpenAI-compatible `reasoning_effort`; `off`
 * omits the parameter entirely rather than sending "none", because providers
 * disagree about what "none" means and silence is unambiguous.
 *
 * The vocabulary is the catalog's, not ours: a model that accepts `xhigh` or
 * `max` gets a level we can name, and a model that only takes a toggle is sent
 * `reasoningToggle` instead of an effort it would reject. See
 * `models/catalog.ts` for where the per-model list comes from.
 */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * For a model whose reasoning is a switch rather than a dial: `true` sends
 * `reasoning: { enabled: true }`, and no reasoning is sent at all for `false`.
 * A toggle model has no effort, so the two are mutually exclusive on the wire.
 */
export type ReasoningToggle = boolean

export interface ChatCompletionRequest {
  apiKey: string
  model: string
  /** Omitted from the wire when 'off'. */
  reasoningEffort?: ReasoningEffort
  /** Set for a toggle-only model; see ReasoningToggle. Ignored with an effort. */
  reasoningToggle?: ReasoningToggle
  messages: ChatMessage[]
  tools?: OpenAiToolSpec[]
  toolChoice?: 'auto' | 'required' | 'none'
  /** Abort mid-request / mid-stream (contract C6). */
  signal?: AbortSignal
  /**
   * Observability only — never affects the response. `chat.ts` owns the
   * round-trip, so it owns the timing; the caller adapts this to the UI port
   * instead of the agent layer importing the UI.
   */
  onEvent?: (event: ChatRoundEvent) => void
  /** Round N of the caller's loop, for llm-start/llm-end. Defaults to 1. */
  round?: number
  /** Cap of the caller's loop, when known. */
  roundBudget?: number
  /**
   * How long the request may go without hearing from the gateway, in ms, before it
   * is abandoned and sent again: no response headers, or no chunk once streaming.
   * A model that is merely slow keeps sending chunks; one that has stalled sends
   * nothing, and waiting longer does not help. Defaults to the request timeout.
   */
  stallMs?: number
}

export type ChatRoundEvent =
  | { type: 'llm-start'; round: number }
  | { type: 'llm-end'; round: number; ms: number; budget?: number; usage?: TokenUsage }
  | { type: 'heartbeat'; elapsedMs: number }
  /** A request went quiet for `afterMs` and is being sent again. */
  | { type: 'llm-stall'; round: number; afterMs: number }

export interface ChatCompletionResult {
  message: ChatMessage
  finishReason: string | null
  /** Provider-reported token usage, when the gateway supplies it. */
  usage?: TokenUsage
}

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
const ZEN_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
const MAX_RETRIES = 5
const INITIAL_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 30_000
const REQUEST_TIMEOUT_MS = 120_000

function resolveBaseURL(model: string): string {
  if (model.startsWith('go/')) return ZEN_GO_BASE_URL
  if (model.startsWith('zen/')) return ZEN_BASE_URL
  throw new Error(
    `Unsupported model '${model}': only zen/* and go/* are supported`,
  )
}

function stripProviderPrefix(model: string): string {
  if (model.startsWith('go/')) return model.slice('go/'.length)
  if (model.startsWith('zen/')) return model.slice('zen/'.length)
  return model
}

function createClient(apiKey: string, baseURL: string): OpenAI {
  const headers: Record<string, string> = {}
  if (baseURL === ZEN_GO_BASE_URL || baseURL === ZEN_BASE_URL) {
    headers['x-opencode-session'] = 'vajra-cli-' + Math.random().toString(36).slice(2, 10)
  }
  return new OpenAI({
    baseURL,
    apiKey,
    maxRetries: 0,
    ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: string }).code
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return true
  const msg = err.message?.toLowerCase() ?? ''
  return msg.includes('connection reset') || msg.includes('socket hang up') || msg.includes('timed out')
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const status = (err as { status?: number }).status
  if (status === 503) return true
  if (status === 429) {
    const msg = err.message?.toLowerCase() ?? ''
    if (msg.includes('per-day') || msg.includes('daily')) return false
    return true
  }
  const msg = err.message?.toLowerCase() ?? ''
  if (msg.includes('overloaded') || msg.includes('rate limit') || msg.includes('too many requests')) return true
  return false
}

function isRetryable(err: unknown): boolean {
  return isRateLimitError(err) || isRetryableNetworkError(err)
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (obj.error && typeof obj.error === 'object') {
      const inner = obj.error as Record<string, unknown>
      if (typeof inner.message === 'string') return inner.message
      return JSON.stringify(inner)
    }
    return JSON.stringify(err)
  }
  return String(err)
}

/** Header value from either a plain object or a Headers-like object. */
function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const h = headers as Record<string, unknown> | { get?: (k: string) => string | null }
  if (typeof (h as { get?: unknown }).get === 'function') {
    const val = (h as { get: (k: string) => string | null }).get(name)
    if (val) return val
    const lower = (h as { get: (k: string) => string | null }).get(name.toLowerCase())
    if (lower) return lower
    return undefined
  }
  const obj = h as Record<string, unknown>
  const direct = obj[name] ?? obj[name.toLowerCase()] ?? obj[name.toUpperCase()]
  if (typeof direct === 'string') return direct
  return undefined
}

/** Explicit retry-after, else exponential backoff with full jitter. */
export function computeRetryDelayMs(err: unknown, attempt: number): number {
  const e = err as { headers?: unknown; error?: { metadata?: { retry_after_seconds?: number } } }
  const headerVal = readHeader(e.headers, 'retry-after')
  if (headerVal) {
    const parsed = parseInt(headerVal, 10)
    if (!isNaN(parsed) && parsed >= 0) return parsed * 1000
  }
  const metaVal = e.error?.metadata?.retry_after_seconds
  if (typeof metaVal === 'number' && metaVal >= 0) return metaVal * 1000

  const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS)
  return Math.floor(Math.random() * base) + 1
}

/**
 * The reasoning fields for one request body, or nothing.
 *
 * An effort wins over a toggle, because a model that publishes a vocabulary is
 * the only one that documents `reasoning_effort`; a toggle-only model gets
 * `reasoning: { enabled: true }`, and both shapes vanish for `off` so that
 * silence stays the unambiguous way to say "do not think harder".
 */
export function reasoningParams(
  effort: ReasoningEffort | undefined,
  toggle?: ReasoningToggle,
): Record<string, unknown> {
  if (effort && effort !== 'off') return { reasoning_effort: effort }
  if (toggle === true) return { reasoning: { enabled: true } }
  return {}
}

/**
 * The reasoning fields for one request, decided per model.
 *
 * The model decides the shape because only the model knows it: the catalog says
 * whether this id takes an effort vocabulary or a plain toggle, and a level the
 * model does not accept is dropped rather than sent. With no catalog entry —
 * a cold cache, an id models.dev has not published — the request carries
 * `reasoning_effort` as it always did, which is the shape the gateway has
 * accepted from us since the first release.
 */
export function reasoningParamsFor(
  model: string,
  effort: ReasoningEffort | undefined,
  explicitToggle?: ReasoningToggle,
): Record<string, unknown> {
  const info = modelInfo(model)
  if (!info) return reasoningParams(effort)
  if (info.reasoningMode === 'none') return {}
  if (info.reasoningMode === 'toggle') {
    // An explicit toggle from the caller wins; otherwise the dial decides.
    const on = explicitToggle ?? Boolean(effort && effort !== 'off')
    return reasoningParams(undefined, on)
  }
  if (info.reasoningMode === 'budget') return {}
  const accepted = effort !== undefined && effort !== 'off' && info.reasoningEfforts.includes(effort)
  return reasoningParams(accepted ? effort : undefined)
}

function toSdkMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: m.tool_call_id ?? '',
        content: m.content ?? '',
      }
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant' as const,
        content: m.content ?? undefined,
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      }
    }
    return {
      role: m.role as 'system' | 'user',
      content: m.content ?? '',
    }
  })
}

function toSdkTools(tools: OpenAiToolSpec[] | undefined): ChatCompletionTool[] | undefined {
  if (!tools) return undefined
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as Record<string, unknown>,
    },
  }))
}

function toUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined,
): TokenUsage | undefined {
  if (!usage || typeof usage.prompt_tokens !== 'number') return undefined
  const promptTokens = usage.prompt_tokens
  const completionTokens = usage.completion_tokens ?? 0
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

const HEARTBEAT_MS = 750

/**
 * Bracket one caller round: `llm-start` on entry, `llm-end` on exit, and a
 * `heartbeat` every 750 ms while the call (including retries and backoff) is
 * outstanding. The heartbeat is what keeps the screen moving through a
 * 40-second provider call — the start/end pair alone leaves it silent.
 *
 * Returns a stop function that accepts the round's usage; call it from a
 * `finally`.
 */
function watchRound(request: ChatCompletionRequest): (usage?: TokenUsage) => void {
  const onEvent = request.onEvent
  if (!onEvent) return () => {}
  const round = request.round ?? 1
  const budget = request.roundBudget
  const startedAt = Date.now()

  onEvent({ type: 'llm-start', round })
  const timer = setInterval(() => {
    onEvent({ type: 'heartbeat', elapsedMs: Date.now() - startedAt })
  }, HEARTBEAT_MS)
  timer.unref?.()

  return (usage?: TokenUsage) => {
    clearInterval(timer)
    onEvent({
      type: 'llm-end',
      round,
      ms: Date.now() - startedAt,
      ...(budget !== undefined ? { budget } : {}),
      ...(usage ? { usage } : {}),
    })
  }
}

export async function streamChatCompletion(
  request: ChatCompletionRequest,
  onTextDelta: (text: string) => void,
  onThinkingDelta?: (text: string) => void,
): Promise<ChatCompletionResult> {
  const baseURL = resolveBaseURL(request.model)
  const resolvedModel = stripProviderPrefix(request.model)
  const client = createClient(request.apiKey, baseURL)
  const params = {
    model: resolvedModel,
    messages: toSdkMessages(request.messages),
    ...reasoningParamsFor(request.model, request.reasoningEffort, request.reasoningToggle),
    ...(request.tools ? { tools: toSdkTools(request.tools) } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    stream: true,
    // The gateway reports totals on a final chunk with an empty `choices`
    // array — without this the meter would never see a number.
    stream_options: { include_usage: true },
  }
  const stallMs = request.stallMs ?? REQUEST_TIMEOUT_MS

  // Characters already shown to the UI — never re-emit them on retry (F4).
  let emitted = 0
  let content = ''

  const endRound = watchRound(request)
  let roundUsage: TokenUsage | undefined
  try {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(request.signal)

      // One watchdog per attempt. It is reset by every chunk, so a long answer that
      // keeps streaming is never cut, and it abandons only a request that has gone
      // quiet. Its abort is told apart from the caller's by `stalled`.
      let stalled = false
      const stallController = new AbortController()
      let stallTimer: ReturnType<typeof setTimeout> | null = null
      const armStall = (): void => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => {
          stalled = true
          stallController.abort()
        }, stallMs)
        stallTimer.unref?.()
      }
      // Request options, not body fields: the SDK reads `signal` and `timeout` only
      // from its second argument. In the body they were serialized and sent to the
      // gateway, and a round that never answered could be stopped by neither.
      const requestOptions = {
        timeout: stallMs,
        signal: request.signal ? AbortSignal.any([request.signal, stallController.signal]) : stallController.signal,
      }

      try {
        armStall()
        const stream = await client.chat.completions.create(params, requestOptions) as AsyncIterable<ChatCompletionChunk>

        content = ''
        let finishReason: string | null = null
        const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

        for await (const chunk of stream) {
          armStall()
          throwIfAborted(request.signal)
          // The usage chunk carries no choices — read it before the guard.
          const usage = toUsage(chunk.usage)
          if (usage) roundUsage = usage
          const choice = chunk.choices[0]
          if (!choice) continue

          const delta = choice.delta

          if (delta?.content) {
            content += delta.content
            if (content.length > emitted) {
              onTextDelta(content.slice(emitted))
              emitted = content.length
            }
          }

          if (onThinkingDelta) {
            const d = delta as Record<string, unknown> | undefined
            const rd = d?.reasoning_details as Array<Record<string, unknown>> | undefined
            if (rd) {
              for (const detail of rd) {
                if (detail.type === 'reasoning.text' && typeof detail.text === 'string') {
                  onThinkingDelta(detail.text)
                }
              }
            }
          }

          if (delta?.tool_calls) {
            for (const fragment of delta.tool_calls) {
              const idx = fragment.index
              const existing = toolCalls.get(idx) ?? { id: '', name: '', arguments: '' }
              if (fragment.id) existing.id = fragment.id
              if (fragment.function?.name) existing.name = fragment.function.name
              if (fragment.function?.arguments) existing.arguments += fragment.function.arguments
              toolCalls.set(idx, existing)
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason
        }

        // The SDK ends a stream that was aborted mid-way quietly, as if it had
        // finished, so the loop above cannot tell a whole answer from a cut one.
        // Whichever side aborted, what was collected is not the answer.
        throwIfAborted(request.signal)
        if (stalled) throw new Error('The stream went quiet and was abandoned.')

        const orderedToolCalls: ToolCall[] = [...toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }))

        const message: ChatMessage = {
          role: 'assistant',
          content: content.length > 0 ? content : null,
          ...(orderedToolCalls.length > 0 ? { tool_calls: orderedToolCalls } : {}),
        }

        return {
          message,
          finishReason,
          ...(roundUsage ? { usage: roundUsage } : {}),
        }
      } catch (err) {
        if (stalled && !request.signal?.aborted) {
          // Quiet for `stallMs`: send the round again, up to the same limit as any
          // other retryable failure. Nothing was acted on, so re-sending is safe.
          request.onEvent?.({ type: 'llm-stall', round: request.round ?? 1, afterMs: stallMs })
          if (attempt < MAX_RETRIES) {
            content = ''
            await sleep(INITIAL_RETRY_DELAY_MS, request.signal)
            continue
          }
          throw new Error(`The model did not answer for ${Math.round(stallMs / 1000)}s, ${MAX_RETRIES + 1} times in a row.`)
        }
        if (isAbortError(err)) throw err
        // Now that the signal reaches the SDK, an abort mid-request surfaces as
        // the SDK's own error type. Callers know an abort by AbortError, so it
        // is re-thrown as one rather than retried or reworded.
        throwIfAborted(request.signal)
        if (isRetryable(err) && attempt < MAX_RETRIES) {
          // Partial content from the failed attempt is discarded; only emit
          // text that was already shown (emitted) is never re-sent.
          content = ''
          const delay = computeRetryDelayMs(err, attempt)
          await sleep(delay, request.signal)
          continue
        }
        throw new Error(extractErrorMessage(err))
      } finally {
        if (stallTimer) clearTimeout(stallTimer)
      }
    }
  } finally {
    endRound(roundUsage)
  }
}
