import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat'

export interface OpenRouterToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenRouterToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAiToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

export interface ChatCompletionRequest {
  apiKey: string
  model: string
  messages: OpenRouterMessage[]
  tools?: OpenAiToolSpec[]
  toolChoice?: 'auto' | 'required' | 'none'
  /** Abort mid-request / mid-stream (contract C6). */
  signal?: AbortSignal
}

export interface ChatCompletionResult {
  message: OpenRouterMessage
  finishReason: string | null
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
const ZEN_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
const MAX_RETRIES = 5
const INITIAL_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 30_000
const REQUEST_TIMEOUT_MS = 120_000

function resolveBaseURL(model: string): string {
  if (model.startsWith('go/')) return ZEN_GO_BASE_URL
  if (model.startsWith('zen/')) return ZEN_BASE_URL
  return OPENROUTER_BASE_URL
}

function stripProviderPrefix(model: string): string {
  if (model.startsWith('go/')) return model.slice('go/'.length)
  if (model.startsWith('zen/')) return model.slice('zen/'.length)
  if (model.startsWith('openrouter/')) {
    const after = model.slice('openrouter/'.length)
    if (after === 'free' || after === 'auto' || after === 'auto-beta') return model
    return after
  }
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

function toSdkMessages(messages: OpenRouterMessage[]): ChatCompletionMessageParam[] {
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

function toResult(completion: ChatCompletion): ChatCompletionResult {
  const choice = completion.choices[0]
  if (!choice) throw new Error('OpenRouter response had no choices')

  const msg = choice.message
  const funcCalls = msg.tool_calls?.filter(tc => tc.type === 'function') ?? []
  const message: OpenRouterMessage = {
    role: 'assistant',
    content: msg.content ?? null,
    ...(funcCalls.length > 0
      ? {
          tool_calls: funcCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        }
      : {}),
  }

  return { message, finishReason: choice.finish_reason ?? null }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

export async function chatCompletion(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const baseURL = resolveBaseURL(request.model)
  const resolvedModel = stripProviderPrefix(request.model)
  const client = createClient(request.apiKey, baseURL)
  const params = {
    model: resolvedModel,
    messages: toSdkMessages(request.messages),
    ...(request.tools ? { tools: toSdkTools(request.tools) } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    timeout: REQUEST_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {}),
  }

  for (let attempt = 0; ; attempt++) {
    throwIfAborted(request.signal)
    try {
      const completion = await client.chat.completions.create(params)
      return toResult(completion)
    } catch (err) {
      if (isAbortError(err)) throw err
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        const delay = computeRetryDelayMs(err, attempt)
        await sleep(delay, request.signal)
        continue
      }
      throw new Error(extractErrorMessage(err))
    }
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
    ...(request.tools ? { tools: toSdkTools(request.tools) } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    stream: true,
    timeout: REQUEST_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {}),
  }

  // Characters already shown to the UI — never re-emit them on retry (F4).
  let emitted = 0
  let content = ''

  for (let attempt = 0; ; attempt++) {
    throwIfAborted(request.signal)
    try {
      const stream = await client.chat.completions.create(params) as AsyncIterable<ChatCompletionChunk>

      content = ''
      let finishReason: string | null = null
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

      for await (const chunk of stream) {
        throwIfAborted(request.signal)
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

      const orderedToolCalls: OpenRouterToolCall[] = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))

      const message: OpenRouterMessage = {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        ...(orderedToolCalls.length > 0 ? { tool_calls: orderedToolCalls } : {}),
      }

      return { message, finishReason }
    } catch (err) {
      if (isAbortError(err)) throw err
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        // Partial content from the failed attempt is discarded; only emit
        // text that was already shown (emitted) is never re-sent.
        content = ''
        const delay = computeRetryDelayMs(err, attempt)
        await sleep(delay, request.signal)
        continue
      }
      throw new Error(extractErrorMessage(err))
    }
  }
}
