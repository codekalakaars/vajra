// Tool call types and parsing shared between CLI and server.

export interface ParsedToolCall {
  tool: string
  args: Record<string, unknown>
}

export type ParseToolCallResult =
  | { ok: true; call: ParsedToolCall }
  | { ok: false; error: string }

/**
 * A generic raw tool call input that both CLI and server can map to.
 */
export interface RawToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * Parse and validate a tool call from any provider.
 * Accepts a generic RawToolCall that both CLI and server can produce.
 */
export function parseToolCall(toolCall: RawToolCall): ParseToolCallResult {
  if (!toolCall.name) {
    return { ok: false, error: 'Tool call missing name' }
  }

  if (!toolCall.arguments) {
    return { ok: false, error: `Tool call ${toolCall.name} missing arguments` }
  }

  let args: Record<string, unknown>
  try {
    args = JSON.parse(toolCall.arguments)
  } catch {
    return { ok: false, error: `Tool call ${toolCall.name} has invalid JSON arguments` }
  }

  if (typeof args !== 'object' || args === null) {
    return { ok: false, error: `Tool call ${toolCall.name} arguments must be an object` }
  }

  return { ok: true, call: { tool: toolCall.name, args } }
}
