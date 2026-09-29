import type { AgentRunInput } from './profile.js'

/**
 * The provider seam.
 *
 * `streamChatCompletion` builds its own OpenAI client per call and offers no
 * injection point, so the only thing a test could reach was the global `fetch`.
 * That is why the CLI's two provider doubles had to be installed before the
 * module under test was imported, and it is why a refactor of the loop had no
 * seam to hang a fake on.
 *
 * The runtime depends on this interface and never on a vendor SDK. A host
 * constructs the client; the engine receives it. Credentials therefore stay in
 * the host process and are never passed to the confined tool process
 * (plan boundary 6).
 */

export interface ModelClient {
  /** One streamed round. Resolves when the provider closes the stream. */
  complete(request: ModelRequest, handlers: ModelHandlers): Promise<ModelResponse>
}

export interface ModelRequest {
  apiKey: string
  model: string
  messages: ModelMessage[]
  tools?: ModelToolSpec[]
  reasoningEffort?: string
  signal?: AbortSignal
  /** 1-based round number, for the events the host renders. */
  round?: number
  /** Which round of the loop's cap this is, when the loop has a cap. */
  roundBudget?: number
}

export interface ModelHandlers {
  onTextDelta: (text: string) => void
  onThinkingDelta?: (text: string) => void
  onEvent?: (event: ModelEvent) => void
}

export type ModelEvent =
  | { type: 'llm-start'; round: number }
  | { type: 'llm-end'; round: number; ms: number; budget?: number; usage?: TokenUsageShape }
  | { type: 'heartbeat'; elapsedMs: number }

export interface TokenUsageShape {
  promptTokens: number
  completionTokens: number
}

export interface ModelResponse {
  message: ModelMessage
  finishReason: string | null
  usage?: TokenUsageShape
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: ModelToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ModelToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ModelToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

/**
 * The tool dispatch port.
 *
 * Separate from `ModelClient` on purpose: the model decides *what* to call, the
 * runtime decides whether it may, and the executor decides what happens. The
 * engine holds all three so that validation, authorization, dispatch, timeout,
 * cancellation and event reporting happen in one place for every role
 * (plan boundary 1).
 */
export interface ToolExecutor {
  /**
   * Run one call. Implementations must apply the permission grant before
   * touching anything, and must not resolve a tool the grant does not list.
   */
  callTool(tool: string, args: unknown, options?: CallOptions): Promise<unknown>
}

export interface CallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/** Everything one run needs from its host, in one argument. */
export interface RuntimeDeps {
  client: ModelClient
  executor: ToolExecutor
  /** Identity for `AgentInstance` records. The host owns the id scheme. */
  newInstanceId?: () => string
  /** Injected so a run's events can be asserted without a wall clock. */
  now?: () => number
}
