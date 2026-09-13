// Provider-agnostic types for LLM interaction.
//
// All agent code (loop, manager, master) depends on ChatProvider, never on a
// concrete SDK. Adding a new provider means implementing this interface — no
// changes to the agent layer.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  toolChoice?: 'auto' | 'required' | 'none'
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatResult {
  message: ChatMessage
  finishReason: string | null
  usage?: TokenUsage
}

export interface ChatProvider {
  /** Human-readable provider name for logging. */
  readonly name: string

  /** Stream a chat completion. Calls onTextDelta for content, onThinkingDelta for reasoning. */
  streamChat(
    request: ChatRequest,
    onTextDelta: (text: string) => void,
    onThinkingDelta?: (text: string) => void,
  ): Promise<ChatResult>
}
