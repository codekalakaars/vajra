import {
  dispatchToolCall,
  startHeartbeat,
  budgetExhausted,
  isFreeTool,
  READ_ONLY_TOOLS,
  type LoopEvent,
  type RunLabel,
} from '@codekalakaars/vajra-agent/engine'
import type { AgentEvent, ModelClient, ModelToolSpec, ToolExecutor } from '@codekalakaars/vajra-agent/contracts'
import type { LaunchHandle } from '@codekalakaars/vajra-agent-process'
import { streamChatCompletion, type ChatMessage } from './chat.js'
import { summarizeToolCall, summarizeToolResult } from '../session/ui.js'

/**
 * The host's side of the runtime seam.
 *
 * The engine speaks `ModelClient` and `ToolExecutor`. This file is where the
 * shipped implementations of both are assembled, because both need things only
 * a host has: the OpenAI client and its per-model reasoning shape, the model
 * catalog behind that shape, and the summarisers that decide what a person is
 * shown.
 *
 * It stays outside `@codekalakaars/vajra-agent/providers` for now, and the
 * reason is written down there: the catalog is host state — it reads
 * `~/.vajra/models.json` and fetches models.dev — and plan boundary 6 says the
 * runtime does not read config or credential files directly.
 */

export interface ModelClientAdapterOptions {
  /** Per-round events, forwarded onto the run's event stream. */
  emit: (event: AgentEvent) => void
}

/**
 * Present `streamChatCompletion` as a `ModelClient`.
 *
 * A thin adapter on purpose. It exists so the engine depends on an interface
 * rather than a vendor SDK, which is what makes the loop testable without
 * replacing a global: the CLI's provider doubles had to be installed before the
 * module under test was imported, because the OpenAI SDK captures the global
 * `fetch` when it loads.
 */
export function createModelClient(options: ModelClientAdapterOptions): ModelClient {
  return {
    async complete(request, handlers) {
      const result = await streamChatCompletion(
        {
          apiKey: request.apiKey,
          model: request.model,
          messages: request.messages as ChatMessage[],
          tools: request.tools as ModelToolSpec[] | undefined,
          reasoningEffort: request.reasoningEffort as never,
          signal: request.signal,
          round: request.round,
          roundBudget: request.roundBudget,
          onEvent: event => options.emit(event as unknown as AgentEvent),
        },
        handlers.onTextDelta,
        handlers.onThinkingDelta,
      )
      return { message: result.message, finishReason: result.finishReason, usage: result.usage }
    },
  }
}

/**
 * Present the confined tool handle as a `ToolExecutor`.
 *
 * The permission decision is deliberately not here and must not be added: the
 * confined process already applies the task scope, and the role allowlist is
 * enforced where the worker resolves a call. This adapter only forwards, so a
 * check added here would become a fifth enforcement site rather than the single
 * chokepoint the plan wants.
 */
export function createToolExecutor(handle: LaunchHandle): ToolExecutor {
  return {
    // `LaunchHandle.callTool` takes no options today. Forwarding the signal is
    // the one thing an executor-level `CallOptions` buys, and it is not wired
    // yet — so it is dropped here rather than pretended. Cancellation currently
    // reaches tool calls through the abort controller the handle closes over.
    callTool: (tool: string, args: unknown) => handle.callTool(tool, args),
  }
}

/**
 * The summarisers the engine asks the host for, plus the event sink.
 *
 * Generic over the caller's label so the CLI's own `AgentLabel` — which still
 * says `developer | worker`, where the runtime contracts already carry
 * `manager` — satisfies the engine's structural label. The engine never
 * interprets a role, so it has no business constraining one.
 */
export function loopHooks<L extends RunLabel>(
  projectDir: string,
  emit: (event: LoopEvent<L>) => void,
): {
  emit: (event: LoopEvent<L>) => void
  summariseCall: (tool: string, args: unknown) => string
  summariseResult: (tool: string, args: unknown, raw: unknown, ms: number) => { ok: boolean; detail?: string }
} {
  return {
    emit,
    summariseCall: (tool, args) => summarizeToolCall(tool, args, projectDir),
    summariseResult: (tool, args, raw, ms) => summarizeToolResult(tool, args, raw, ms),
  }
}

export { dispatchToolCall, startHeartbeat, budgetExhausted, isFreeTool, READ_ONLY_TOOLS }
export type { ModelClient, ToolExecutor, AgentEvent, RunLabel, LoopEvent }
