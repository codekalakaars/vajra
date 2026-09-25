// Provider tool-spec adapters + tool-call validation.
//
// Parsing lives in @codekalakaars/vajra-agent-core (Group N). This layer only
// maps the protocol's OpenAI/Anthropic shapes onto the server's ToolSpec and
// ToolCall types. Worker dispatch re-validates independently — this is a
// cheap pre-check for malformed model output, not the security boundary.

import {
  toOpenAiToolSpecs,
  toAnthropicToolSpecs,
  roleTools,
} from '@codekalakaars/vajra-protocol'
import {
  parseToolCall as parseRawToolCall,
  type ParsedToolCall,
  type ParseToolCallResult,
} from '@codekalakaars/vajra-agent-core'
import type { ToolCall, ToolSpec } from './providers/types.js'

function toToolSpecs(provider: 'openai' | 'anthropic', tools?: Parameters<typeof toOpenAiToolSpecs>[0]): ToolSpec[] {
  const raw = provider === 'anthropic' ? toAnthropicToolSpecs(tools) : toOpenAiToolSpecs(tools)
  return raw.map((s) => {
    if ('function' in s) {
      return {
        name: s.function.name,
        description: s.function.description,
        parameters: s.function.parameters as unknown as Record<string, unknown>,
      }
    }
    return {
      name: s.name,
      description: s.description,
      parameters: s.input_schema as unknown as Record<string, unknown>,
    }
  })
}

export function getToolSpecs(provider: 'openai' | 'anthropic' = 'openai'): ToolSpec[] {
  return toToolSpecs(provider)
}

/** Tool specs for the Developer role (read-only + propose_plan). */
export function getDeveloperToolSpecs(provider: 'openai' | 'anthropic' = 'openai'): ToolSpec[] {
  return toToolSpecs(provider, roleTools.developer)
}

export type { ParsedToolCall, ParseToolCallResult }

export function parseToolCall(raw: ToolCall): ParseToolCallResult {
  return parseRawToolCall({
    id: raw.id,
    function: { name: raw.name, arguments: raw.arguments },
  })
}
