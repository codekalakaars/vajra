// Anthropic provider — uses the official Anthropic SDK.
//
// Anthropic's API differs from OpenAI's in several ways:
// - System prompt is a separate parameter, not a message
// - Tool calls are content blocks (type: 'tool_use') in assistant messages
// - Tool results are content blocks (type: 'tool_result') in user messages
// - Streaming uses SSE with content_block events

import Anthropic from '@anthropic-ai/sdk'
import type { ChatProvider, ChatRequest, ChatResult, ChatMessage, ToolCall, ToolSpec } from './types.js'

const MAX_RETRIES = 5
const INITIAL_RETRY_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    return JSON.stringify(err)
  }
  return String(err)
}

function retryAfterMs(err: unknown): number {
  const e = err as { headers?: Record<string, string> }
  const headerVal = e.headers?.['retry-after']
  if (headerVal) {
    const parsed = parseInt(headerVal, 10)
    if (!isNaN(parsed)) return parsed * 1000
  }
  return INITIAL_RETRY_DELAY_MS
}

function isOverloadedError(err: unknown): boolean {
  return err instanceof Error && 'status' in err && (err as { status: number }).status === 529
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  let system = ''
  const out: AnthropicMessage[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      // Concatenate multiple system messages
      system += (system ? '\n\n' : '') + (m.content ?? '')
      continue
    }

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content ?? '' })
      continue
    }

    if (m.role === 'assistant') {
      // Assistant with tool calls — content block array
      if (m.toolCalls && m.toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = []
        if (m.content) {
          blocks.push({ type: 'text', text: m.content })
        }
        for (const tc of m.toolCalls) {
          let input: unknown
          try {
            input = JSON.parse(tc.arguments)
          } catch {
            input = {}
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input,
          })
        }
        out.push({ role: 'assistant', content: blocks })
      } else {
        out.push({ role: 'assistant', content: m.content ?? '' })
      }
      continue
    }

    if (m.role === 'tool') {
      // Tool result → user message with tool_result content block
      const toolResultBlock = {
        type: 'tool_result' as const,
        tool_use_id: m.toolCallId ?? '',
        content: m.content ?? '',
      }
      // Find the last user message and merge, or create new one
      const lastMsg = out[out.length - 1]
      if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push(toolResultBlock)
      } else {
        out.push({ role: 'user', content: [toolResultBlock] })
      }
    }
  }

  return { system, messages: out }
}

function toAnthropicTools(tools: ToolSpec[] | undefined): Anthropic.Tool[] | undefined {
  if (!tools) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }))
}

function extractContentBlocks(content: string | AnthropicContentBlock[]): {
  text: string
  toolCalls: ToolCall[]
} {
  if (typeof content === 'string') {
    return { text: content, toolCalls: [] }
  }

  let text = ''
  const toolCalls: ToolCall[] = []

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      text += block.text
    } else if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      })
    }
  }

  return { text, toolCalls }
}

export class AnthropicProvider implements ChatProvider {
  readonly name = 'anthropic'

  async streamChat(
    request: ChatRequest,
    onTextDelta: (text: string) => void,
    onThinkingDelta?: (text: string) => void,
  ): Promise<ChatResult> {
    const client = new Anthropic({ apiKey: request.apiKey })
    const { system, messages } = toAnthropicMessages(request.messages)

    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: 16384,
      messages,
      ...(system ? { system } : {}),
      ...(request.tools ? { tools: toAnthropicTools(request.tools) } : {}),
      stream: true,
    }

    let stream: Anthropic.RawMessageStream
    for (let attempt = 0; ; attempt++) {
      try {
        stream = client.messages.stream(params)
        break
      } catch (err) {
        if ((isOverloadedError(err)) && attempt < MAX_RETRIES) {
          const delay = retryAfterMs(err)
          await sleep(delay)
          continue
        }
        throw new Error(extractErrorMessage(err))
      }
    }

    let content = ''
    let stopReason: string | null = null
    const toolCalls = new Map<string, { id: string; name: string; arguments: string }>()

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block
        if (block.type === 'tool_use' && block.id) {
          toolCalls.set(block.index, { id: block.id, name: block.name, arguments: '' })
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta
        if (delta.type === 'text_delta' && delta.text) {
          content += delta.text
          onTextDelta(delta.text)
        } else if (delta.type === 'thinking_delta' && delta.thinking && onThinkingDelta) {
          onThinkingDelta(delta.thinking)
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          // Find the tool call by index — content_block_delta events come in order
          const lastToolCall = [...toolCalls.values()].pop()
          if (lastToolCall) {
            lastToolCall.arguments += delta.partial_json
          }
        }
      } else if (event.type === 'message_delta') {
        if (event.delta.stop_reason) {
          stopReason = event.delta.stop_reason
        }
      }
    }

    const toolCallArray: ToolCall[] | undefined = toolCalls.size > 0
      ? [...toolCalls.values()]
      : undefined

    const message: ChatMessage = {
      role: 'assistant',
      content: content.length > 0 ? content : null,
      ...(toolCallArray ? { toolCalls: toolCallArray } : {}),
    }

    return { message, finishReason: stopReason }
  }
}
