// A minimal OpenRouter chat-completions client.
//
// OpenRouter's API is OpenAI-compatible: `tools`/`tool_choice` for function
// calling, `choices[0].message.tool_calls` in a non-streaming response, and
// SSE deltas (`choices[0].delta`) when streaming. No HTTP library dependency
// — Node has had a global `fetch` and the web Streams API since 18.
//
// `fetchImpl` is injectable (defaults to the global) so tests can stub
// responses without a live API key or network access.

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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

function buildBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    stream,
  }
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

async function errorFromResponse(response: Response): Promise<Error> {
  const body = await response.text().catch(() => '')
  return new Error(`OpenRouter request failed: ${response.status} ${body}`)
}

export async function chatCompletion(
  request: ChatCompletionRequest,
  fetchImpl: FetchLike = fetch,
): Promise<ChatCompletionResult> {
  const response = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: buildHeaders(request.apiKey),
    body: JSON.stringify(buildBody(request, false)),
  })

  if (!response.ok) {
    throw await errorFromResponse(response)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message: OpenRouterMessage; finish_reason?: string | null }>
  }
  const choice = data.choices?.[0]
  if (!choice) {
    throw new Error('OpenRouter response had no choices')
  }

  return { message: choice.message, finishReason: choice.finish_reason ?? null }
}

export async function streamChatCompletion(
  request: ChatCompletionRequest,
  onTextDelta: (text: string) => void,
  fetchImpl: FetchLike = fetch,
): Promise<ChatCompletionResult> {
  const response = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: buildHeaders(request.apiKey),
    body: JSON.stringify(buildBody(request, true)),
  })

  if (!response.ok || !response.body) {
    throw await errorFromResponse(response)
  }

  return consumeSseStream(response.body, onTextDelta)
}

interface AccumulatingToolCall {
  id?: string
  type?: 'function'
  function: { name?: string; arguments: string }
}

/**
 * Reads an OpenAI-compatible SSE stream and accumulates it into one final
 * message. Tool-call deltas arrive fragmented across many chunks, keyed by
 * `index` — `id` and `function.name` are typically only present on the first
 * fragment for a given index, and `function.arguments` is a partial JSON
 * string that has to be concatenated across fragments, not replaced.
 */
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onTextDelta: (text: string) => void,
): Promise<ChatCompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  let content = ''
  let finishReason: string | null = null
  const toolCalls = new Map<number, AccumulatingToolCall>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)

      if (!line.startsWith('data:')) continue
      const data = line.slice('data:'.length).trim()
      if (data === '[DONE]') continue
      if (data === '') continue

      let event: {
        choices?: Array<{
          delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }> }
          finish_reason?: string | null
        }>
      }
      try {
        event = JSON.parse(data)
      } catch {
        // A malformed individual SSE frame is skipped, not fatal to the
        // whole stream — a stray keepalive or partial write shouldn't lose
        // everything accumulated so far.
        continue
      }

      const choice = event.choices?.[0]
      if (!choice) continue

      if (choice.delta?.content) {
        content += choice.delta.content
        onTextDelta(choice.delta.content)
      }

      if (choice.delta?.tool_calls) {
        for (const fragment of choice.delta.tool_calls) {
          const existing = toolCalls.get(fragment.index) ?? { function: { arguments: '' } }
          if (fragment.id) existing.id = fragment.id
          if (fragment.type) existing.type = fragment.type
          if (fragment.function?.name) existing.function.name = fragment.function.name
          if (fragment.function?.arguments) existing.function.arguments += fragment.function.arguments
          toolCalls.set(fragment.index, existing)
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  }

  const orderedToolCalls: OpenRouterToolCall[] = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id ?? '',
      type: 'function',
      function: { name: call.function.name ?? '', arguments: call.function.arguments },
    }))

  const message: OpenRouterMessage = {
    role: 'assistant',
    content: content.length > 0 ? content : null,
    ...(orderedToolCalls.length > 0 ? { tool_calls: orderedToolCalls } : {}),
  }

  return { message, finishReason }
}
