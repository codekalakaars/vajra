// Shared implementation for OpenAI-compatible endpoints.
//
// OpenRouter and Zen differ only in base URL and name: message conversion,
// tool conversion, stream accumulation, retries and deadlines were duplicated
// line for line between them, so a fix to one silently left the other alone.
// Anything speaking the OpenAI chat-completions API — a self-hosted gateway,
// Ollama, together.ai — can subclass this.

import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat'
import type { ChatProvider, ChatRequest, ChatResult, ChatMessage, ToolCall, TokenUsage } from './types.js'
import { REQUEST_TIMEOUT_MS, requestAbort, withIdleTimeout } from './limits.js'

const MAX_RETRIES = 5
const INITIAL_RETRY_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether a failed request is worth repeating.
 *
 * A gateway hiccup is as transient as a rate limit, so 5xx is retried. A
 * daily quota is not transient at all, so it is not.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false

  const status = (err as { status?: number }).status
  const msg = err.message?.toLowerCase() ?? ''

  if (status === 429) {
    return !(msg.includes('per-day') || msg.includes('daily'))
  }
  if (status !== undefined && status >= 500) return true

  return msg.includes('overloaded') || msg.includes('rate limit') || msg.includes('too many requests')
}

export function extractErrorMessage(err: unknown): string {
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

export function toSdkMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      if (!m.toolCallId) {
        throw new Error(
          'Missing toolCallId on tool result message. ' +
          'Every tool result must reference the tool call it answers.',
        )
      }
      return {
        role: 'tool' as const,
        tool_call_id: m.toolCallId,
        content: m.content ?? '',
      }
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant' as const,
        content: m.content ?? undefined,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }
    }
    return {
      role: m.role as 'system' | 'user',
      content: m.content ?? '',
    }
  })
}

export function toSdkTools(tools: ChatRequest['tools']): ChatCompletionTool[] | undefined {
  if (!tools) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }))
}

export class OpenAiCompatibleProvider implements ChatProvider {
  constructor(
    readonly name: string,
    private readonly baseURL: string,
  ) {}

  async streamChat(
    request: ChatRequest,
    onTextDelta: (text: string) => void,
    onThinkingDelta?: (text: string) => void,
  ): Promise<ChatResult> {
    const client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: request.apiKey,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    })

    const params = {
      model: request.model,
      messages: toSdkMessages(request.messages),
      ...(request.tools ? { tools: toSdkTools(request.tools) } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }

    const { controller, dispose } = requestAbort(request.signal)
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const raw = (await client.chat.completions.create(
            params as never,
            { signal: controller.signal },
          )) as unknown as AsyncIterable<ChatCompletionChunk>

          return await this.accumulate(raw, controller, onTextDelta, onThinkingDelta)
        } catch (err) {
          if (isRetryableError(err) && attempt < MAX_RETRIES && !controller.signal.aborted) {
            await sleep(retryAfterMs(err))
            continue
          }
          throw new Error(extractErrorMessage(err))
        }
      }
    } finally {
      dispose()
    }
  }

  /** Fold the stream into a single assistant message. */
  private async accumulate(
    raw: AsyncIterable<ChatCompletionChunk>,
    controller: AbortController,
    onTextDelta: (text: string) => void,
    onThinkingDelta?: (text: string) => void,
  ): Promise<ChatResult> {
    // A provider that holds the connection open without sending anything
    // would otherwise wedge the run forever.
    const stream = withIdleTimeout(raw, this.name, () => controller.abort())

    let content = ''
    let finishReason: string | null = null
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let usage: TokenUsage | undefined

    // Buffer deltas so that on retry the caller can distinguish between
    // text it has already emitted (from a previous attempt) and new text.
    const textDeltas: string[] = []
    const thinkingDeltas: string[] = []

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        }
      }

      // Usage may arrive in a final chunk that carries no choice.
      const choice = chunk.choices[0]
      if (!choice) continue

      const delta = choice.delta

      if (delta?.content) {
        content += delta.content
        textDeltas.push(delta.content)
      }

      if (onThinkingDelta) {
        const details = (delta as Record<string, unknown> | undefined)?.reasoning_details as
          | Array<Record<string, unknown>>
          | undefined
        for (const detail of details ?? []) {
          if (detail.type === 'reasoning.text' && typeof detail.text === 'string') {
            thinkingDeltas.push(detail.text)
          }
        }
      }

      // Tool calls arrive in fragments, keyed by their position in the list.
      for (const fragment of delta?.tool_calls ?? []) {
        const existing = toolCalls.get(fragment.index) ?? { id: '', name: '', arguments: '' }
        if (fragment.id) existing.id = fragment.id
        if (fragment.function?.name) existing.name = fragment.function.name
        if (fragment.function?.arguments) existing.arguments += fragment.function.arguments
        toolCalls.set(fragment.index, existing)
      }

      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    // An aborted request ends the stream rather than throwing, so a
    // cancelled turn would otherwise come back as a partial answer that
    // looks complete.
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw new Error(
        `${this.name} request cancelled: ${reason instanceof Error ? reason.message : String(reason ?? 'aborted')}`,
      )
    }

    // Emit buffered deltas only after the stream completes successfully.
    // On retry the buffer is discarded and a fresh one starts, so the
    // caller never sees replayed text from a failed attempt.
    for (const delta of textDeltas) onTextDelta(delta)
    for (const delta of thinkingDeltas) onThinkingDelta?.(delta)

    const orderedToolCalls: ToolCall[] = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }))

    const message: ChatMessage = {
      role: 'assistant',
      content: content.length > 0 ? content : null,
      ...(orderedToolCalls.length > 0 ? { toolCalls: orderedToolCalls } : {}),
    }

    return { message, finishReason, usage }
  }
}
