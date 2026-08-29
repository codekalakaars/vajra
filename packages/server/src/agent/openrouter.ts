// OpenRouter chat-completions client backed by the OpenAI SDK.
//
// OpenRouter's API is OpenAI-compatible, so the official `openai` package works
// out of the box — just point it at OpenRouter's base URL.  The SDK handles
// SSE parsing, tool-call delta accumulation, retries, and streaming.
//
// `fetchImpl` is kept in the public interface so tests can stub it, but the
// SDK ignores it when constructing its own internal client.

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
}

export interface ChatCompletionResult {
  message: OpenRouterMessage
  finishReason: string | null
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const MAX_RETRIES = 5
const INITIAL_RETRY_DELAY_MS = 1000

function createClient(apiKey: string): OpenAI {
  return new OpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey, maxRetries: 0 })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && 'status' in err && (err as { status: number }).status === 429
}

function retryAfterMs(err: unknown): number {
  const e = err as { headers?: Record<string, string>; error?: { metadata?: { retry_after_seconds?: number } } }
  const headerVal = e.headers?.['retry-after']
  if (headerVal) {
    const parsed = parseInt(headerVal, 10)
    if (!isNaN(parsed)) return parsed * 1000
  }
  const metaVal = e.error?.metadata?.retry_after_seconds
  if (metaVal) return metaVal * 1000
  return INITIAL_RETRY_DELAY_MS
}

function toSdkMessages(messages: OpenRouterMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
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
        tool_calls: m.tool_calls.map((tc) => ({
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
  return tools.map((t) => ({
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
  const funcCalls = msg.tool_calls?.filter((tc) => tc.type === 'function') ?? []
  const message: OpenRouterMessage = {
    role: 'assistant',
    content: msg.content ?? null,
    ...(funcCalls.length > 0
      ? {
          tool_calls: funcCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        }
      : {}),
  }

  return { message, finishReason: choice.finish_reason ?? null }
}

/**
 * Non-streaming chat completion.  Used during the plan phase where we need
 * the full response before proceeding.  Retries on 429 with backoff.
 */
export async function chatCompletion(
  request: ChatCompletionRequest,
  _fetchImpl?: FetchLike,
): Promise<ChatCompletionResult> {
  const client = createClient(request.apiKey)
  const params = {
    model: request.model,
    messages: toSdkMessages(request.messages),
    ...(request.tools ? { tools: toSdkTools(request.tools) } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const completion = await client.chat.completions.create(params)
      return toResult(completion)
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        const delay = retryAfterMs(err)
        await sleep(delay)
        continue
      }
      throw err
    }
  }
}

/**
 * Streaming chat completion.  Calls `onTextDelta` for each text chunk and
 * `onThinkingDelta` for each reasoning/thinking token chunk.  Retries on
 * 429 before any tokens are emitted.
 */
export async function streamChatCompletion(
  request: ChatCompletionRequest,
  onTextDelta: (text: string) => void,
  onThinkingDelta?: (text: string) => void,
  _fetchImpl?: FetchLike,
): Promise<ChatCompletionResult> {
  const client = createClient(request.apiKey)
  const params = {
    model: request.model,
    messages: toSdkMessages(request.messages),
    ...(request.tools ? { tools: toSdkTools(request.tools) } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    stream: true,
  }

  let stream: AsyncIterable<ChatCompletionChunk>
  for (let attempt = 0; ; attempt++) {
    try {
      stream = await client.chat.completions.create(params) as AsyncIterable<ChatCompletionChunk>
      break
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        const delay = retryAfterMs(err)
        await sleep(delay)
        continue
      }
      throw err
    }
  }

  let content = ''
  let finishReason: string | null = null
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

  for await (const chunk of stream) {
    const choice = chunk.choices[0]
    if (!choice) continue

    const delta = choice.delta

    // Text content
    if (delta?.content) {
      content += delta.content
      onTextDelta(delta.content)
    }

    // Thinking / reasoning tokens — OpenRouter returns reasoning_details
    // on the delta, but the SDK types don't include it yet.  Access via
    // a type assertion.
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

    // Tool calls (SDK delivers fragments keyed by index)
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
}
