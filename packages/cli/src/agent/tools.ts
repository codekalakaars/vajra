// Re-export — implementation lives in @codekalakaars/vajra-agent-core (Group N).
// Types are structurally compatible with the CLI's openrouter OpenAiToolSpec.

export {
  type ParsedToolCall,
  type ParseToolCallResult,
  type RawToolCall as OpenRouterToolCall,
  type OpenAiToolSpec,
  parseToolCall,
  getToolSpecs,
  getDeveloperToolSpecs,
  getWorkerToolSpecs,
} from '@codekalakaars/vajra-agent-core'
