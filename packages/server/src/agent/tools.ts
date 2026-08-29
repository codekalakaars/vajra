// Bridges OpenRouter's wire format for tool calls to the {tool, args} shape
// the sandboxed worker's dispatch loop expects.
//
// This validation is deliberately separate from — and does not replace —
// the worker's own re-validation in worker/sandboxed-worker.mjs. That
// process is the actual security boundary and never trusts this layer's
// output. This layer exists so a malformed model response (an unknown tool
// name, non-JSON arguments, a schema mismatch) produces an immediate,
// cheap tool-result error the model can see and react to, without spending
// an IPC round trip to the worker on something already known to be invalid.

import { toolDefinitions, toOpenAiToolSpecs, type ToolName } from '@vajra/protocol'
import type { OpenRouterToolCall, OpenAiToolSpec } from './openrouter.js'

export function getToolSpecs(): OpenAiToolSpec[] {
  return toOpenAiToolSpecs()
}

export interface ParsedToolCall {
  callId: string
  tool: ToolName
  args: unknown
}

export type ParseToolCallResult =
  | { ok: true; call: ParsedToolCall }
  | { ok: false; callId: string; error: string }

export function parseToolCall(raw: OpenRouterToolCall): ParseToolCallResult {
  const def = toolDefinitions[raw.function.name as ToolName]
  if (!def) {
    return { ok: false, callId: raw.id, error: `Unknown tool '${raw.function.name}'` }
  }

  let rawArgs: unknown
  try {
    rawArgs = JSON.parse(raw.function.arguments)
  } catch (e) {
    return {
      ok: false,
      callId: raw.id,
      error: `Tool arguments were not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const parsed = def.schema.safeParse(rawArgs)
  if (!parsed.success) {
    return {
      ok: false,
      callId: raw.id,
      error: `Invalid arguments for '${raw.function.name}': ${parsed.error.message}`,
    }
  }

  return { ok: true, call: { callId: raw.id, tool: raw.function.name as ToolName, args: parsed.data } }
}
