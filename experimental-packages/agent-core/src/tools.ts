// Tool call types, protocol-validated parsing, and OpenAI tool-spec builders.

import { toolDefinitions, toOpenAiToolSpecs, roleTools, type ToolName } from '@codekalakaars/vajra-protocol'

/** OpenAI-compatible function tool spec (same shape OpenRouter accepts). */
export interface OpenAiToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

/** Provider tool-call fragment (OpenRouter / OpenAI streaming shape). */
export interface RawToolCall {
  id: string
  type?: string
  function: { name: string; arguments: string }
}

export function getToolSpecs(): OpenAiToolSpec[] {
  return toOpenAiToolSpecs() as OpenAiToolSpec[]
}

export function getDeveloperToolSpecs(): OpenAiToolSpec[] {
  return toOpenAiToolSpecs(roleTools.developer) as OpenAiToolSpec[]
}

export function getWorkerToolSpecs(): OpenAiToolSpec[] {
  return toOpenAiToolSpecs(roleTools.worker) as OpenAiToolSpec[]
}

export interface ParsedToolCall {
  callId: string
  tool: ToolName
  args: unknown
}

export type ParseToolCallResult =
  | { ok: true; call: ParsedToolCall }
  | { ok: false; callId: string; error: string }

export function parseToolCall(raw: RawToolCall): ParseToolCallResult {
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
