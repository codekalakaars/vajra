// Bridges the provider-agnostic tool call format to the {tool, args} shape
// the sandboxed worker's dispatch loop expects.
//
// This validation is deliberately separate from — and does not replace —
// the worker's own re-validation in worker/sandboxed-worker.mjs. That
// process is the actual security boundary and never trusts this layer's
// output. This layer exists so a malformed model response (an unknown tool
// name, non-JSON arguments, a schema mismatch) produces an immediate,
// cheap tool-result error the model can see and react to, without spending
// an IPC round trip to the worker on something already known to be invalid.

import { toolDefinitions, toOpenAiToolSpecs, toAnthropicToolSpecs, roleTools, type ToolName } from '@codekalakaars/vajra-protocol'
import type { ToolCall, ToolSpec } from './providers/types.js'

export function getToolSpecs(provider: 'openai' | 'anthropic' = 'openai'): ToolSpec[] {
  const raw = provider === 'anthropic' ? toAnthropicToolSpecs() : toOpenAiToolSpecs()
  return raw.map((s) => {
    if ('function' in s) {
      return { name: s.function.name, description: s.function.description, parameters: s.function.parameters as unknown as Record<string, unknown> }
    }
    return { name: s.name, description: s.description, parameters: s.input_schema as unknown as Record<string, unknown> }
  })
}

/** Tool specs for the Manager role (read-only + propose_plan). */
export function getManagerToolSpecs(provider: 'openai' | 'anthropic' = 'openai'): ToolSpec[] {
  const raw = provider === 'anthropic' ? toAnthropicToolSpecs(roleTools.manager) : toOpenAiToolSpecs(roleTools.manager)
  return raw.map((s) => {
    if ('function' in s) {
      return { name: s.function.name, description: s.function.description, parameters: s.function.parameters as unknown as Record<string, unknown> }
    }
    return { name: s.name, description: s.description, parameters: s.input_schema as unknown as Record<string, unknown> }
  })
}

export interface ParsedToolCall {
  callId: string
  tool: ToolName
  args: unknown
}

export type ParseToolCallResult =
  | { ok: true; call: ParsedToolCall }
  | { ok: false; callId: string; error: string }

export function parseToolCall(raw: ToolCall): ParseToolCallResult {
  const def = toolDefinitions[raw.name as ToolName]
  if (!def) {
    return { ok: false, callId: raw.id, error: `Unknown tool '${raw.name}'` }
  }

  let rawArgs: unknown
  try {
    rawArgs = JSON.parse(raw.arguments)
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
      error: `Invalid arguments for '${raw.name}': ${parsed.error.message}`,
    }
  }

  return { ok: true, call: { callId: raw.id, tool: raw.name as ToolName, args: parsed.data } }
}
