// OpenRouter provider — wraps the OpenAI SDK pointed at OpenRouter's base URL.
//
// Extracted from the original openrouter.ts. This is the default provider and
// supports any OpenAI-compatible endpoint (OpenRouter, Ollama, together.ai, etc.)

import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat'
import type { ChatProvider, ChatRequest, ChatResult, ChatMessage, ToolCall, TokenUsage } from './types.js'

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

function toSdkMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: m.toolCallId ?? '',
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

function toSdkTools(tools: ChatRequest['tools']): ChatCompletionTool[] | undefined {
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

function toResult(completion: ChatCompletion): ChatResult {
  const choice = completion.choices[0]
  if (!choice) throw new Error('OpenRouter response had no choices')

  const msg = choice.message
  const funcCalls = msg.tool_calls?.filter((tc) => tc.type === 'function') ?? []
  const toolCalls: ToolCall[] | undefined = funcCalls.length > 0
    ? funcCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
    : undefined

  const message: ChatMessage = {
    role: 'assistant',
    content: msg.content ?? null,
    ...(toolCalls ? { toolCalls } : {}),
  }

  return { message, finishReason: choice.finish_reason ?? null }
}

export class OpenRouterProvider implements ChatProvider {
  readonly name = 'openrouter'

  async streamChat(
    request: ChatRequest,
    onTextDelta: (text: string) => void,
    onThinkingDelta?: (text: string) => void,
  ): Promise<ChatResult> {
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
        throw new Error(extractErrorMessage(err))
      }
    }

    let content = ''
    let finishReason: string | null = null
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let usage: TokenUsage | undefined

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) {
        // Usage may come in the final chunk without a choice
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          }
        }
        continue
      }

      const delta = choice.delta

      if (delta?.content) {
        content += delta.content
        onTextDelta(delta.content)
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

      // Usage may come in any chunk
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        }
      }
    }

    const orderedToolCalls: ToolCall[] = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }))

    const message: ChatMessage = {
      role: 'assistant',
      content: content.length > 0 ? content : null,
      ...(orderedToolCalls.length > 0 ? { toolCalls: orderedToolCalls } : {}),
    }

    return { message, finishReason, usage }
  }
}
