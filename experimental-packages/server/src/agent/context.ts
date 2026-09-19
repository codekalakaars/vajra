// Context window optimization utilities.
//
// Provides token-aware compression for chat messages to prevent
// exceeding LLM context limits while preserving important information.

import type { ChatMessage } from './providers/types.js'

// Approximate tokens per character (conservative estimate)
const CHARS_PER_TOKEN = 4

// Tool results are truncated to this many characters when a kept block still
// does not fit the budget.
const TOOL_RESULT_MAX_CHARS = 500

// Maximum context sizes by model (in tokens)
const MODEL_LIMITS: Record<string, number> = {
  'nvidia/nemotron-3-ultra-550b-a55b:free': 1000000,
  'nvidia/nemotron-3-super-120b-a12b:free': 262144,
  'nvidia/nemotron-3.5-lightning:free': 1000000,
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 256000,
  'dots-studio/dots-3-note-preview:free': 512000,
  'google/gemma-4-31b-it:free': 262144,
  'google/gemma-4-26b-a4b-it:free': 262144,
  'nex-agi/nex-n2.5-pro:free': 262144,
  'poolside/laguna-s-2.1:free': 262144,
  'poolside/laguna-xs-2.1:free': 262144,
  'cohere/north-mini-code:free': 256000,
  'inclusionai/ling-3.0-flash-vl:free': 262144,
  'anthropic/claude-3.5-sonnet': 200000,
  'anthropic/claude-3-opus': 200000,
  // Zen models
  'deepseek-v4-flash-free': 128000,
  'mimo-v2.5-free': 128000,
  'nemotron-3-ultra-free': 1000000,
  'nemotron-3.5-lightning-free': 1000000,
  'nemotron-3-super-free': 262144,
  'ling-3.0-flash-fin-free': 128000,
  'gpt-5.5': 256000,
  'gpt-5.4': 256000,
  'gpt-5.4-mini': 128000,
  'deepseek-v4-pro': 128000,
  'kimi-k3': 128000,
  'big-pickle': 128000,
  'mimo-v2.5': 128000,
  'mimo-v2.5-pro': 128000,
  default: 128000,
}

/**
 * Estimate token count for a message.
 */
export function estimateTokens(message: ChatMessage): number {
  let tokens = 0

  // Content tokens
  if (message.content) {
    tokens += Math.ceil(message.content.length / CHARS_PER_TOKEN)
  }

  // Tool call tokens (arguments are JSON strings)
  if (message.toolCalls) {
    for (const toolCall of message.toolCalls) {
      tokens += Math.ceil(toolCall.name.length / CHARS_PER_TOKEN)
      tokens += Math.ceil(toolCall.arguments.length / CHARS_PER_TOKEN)
    }
  }

  // Overhead per message
  tokens += 4

  return tokens
}

/**
 * Get max tokens for a model.
 */
export function getModelLimit(model: string): number {
  // Check for exact match
  if (MODEL_LIMITS[model]) {
    return MODEL_LIMITS[model]
  }

  // Check for partial match (avoid matching 'default' key with substring)
  for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
    if (key !== 'default' && (model === key || model.endsWith('/' + key) || model.includes(key + ':'))) {
      return limit
    }
  }

  return MODEL_LIMITS.default
}

/**
 * A block is the smallest unit of conversation that can be dropped without
 * corrupting the transcript: either a standalone message, or an assistant
 * message carrying tool calls together with every tool result that answers
 * them. Providers reject a `tool` message whose originating `tool_calls`
 * are absent (and an assistant `tool_calls` with no results), so dropping
 * messages individually — as this function used to — produces a 400 exactly
 * when the context is full.
 */
interface MessageBlock {
  messages: ChatMessage[]
  tokens: number
}

const COMPRESSION_NOTICE_PREFIX = '[System: '

function isCompressionNotice(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(COMPRESSION_NOTICE_PREFIX) &&
    message.content.includes('compressed to fit context window')
  )
}

function blockTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0)
}

/**
 * Group non-system messages into atomically droppable blocks.
 */
function groupIntoBlocks(messages: ChatMessage[]): MessageBlock[] {
  const blocks: MessageBlock[] = []
  let current: ChatMessage[] | null = null

  for (const message of messages) {
    if (message.role === 'tool' && current !== null) {
      // Tool results belong to the assistant turn that requested them.
      current.push(message)
      continue
    }

    if (current !== null) {
      blocks.push({ messages: current, tokens: blockTokens(current) })
      current = null
    }

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      current = [message]
      continue
    }

    blocks.push({ messages: [message], tokens: estimateTokens(message) })
  }

  if (current !== null) {
    blocks.push({ messages: current, tokens: blockTokens(current) })
  }

  return blocks
}

/**
 * Truncate a tool result in place, returning the tokens saved.
 */
function truncateToolResult(block: MessageBlock, index: number): number {
  const message = block.messages[index]
  if (message.role !== 'tool' || !message.content || message.content.length <= TOOL_RESULT_MAX_CHARS) {
    return 0
  }

  const truncated = message.content.slice(0, TOOL_RESULT_MAX_CHARS) + '\n... (truncated)'
  const saved = estimateTokens(message) - estimateTokens({ ...message, content: truncated })
  block.messages[index] = { ...message, content: truncated }
  block.tokens -= saved
  return saved
}

/**
 * Compress messages to fit within the model's token limit.
 *
 * Strategy:
 * 1. Always keep every system message.
 * 2. Keep the most recent blocks that fit, newest first, never splitting an
 *    assistant tool-call turn from its tool results.
 * 3. If the kept blocks still do not fit, truncate their tool results
 *    oldest-first.
 * 4. Note how many blocks were dropped, so the model knows context is missing.
 *
 * The returned array is a new array; the caller's history is never mutated.
 */
export function compressMessages(
  messages: ChatMessage[],
  model: string,
  reserveTokens: number = 2000, // Reserve for response
): ChatMessage[] {
  const maxTokens = getModelLimit(model) - reserveTokens
  const totalTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg), 0)

  // If under limit, return as-is
  if (totalTokens <= maxTokens) {
    return messages
  }

  // Drop notices from earlier compressions rather than stacking a new one on
  // top of them every turn.
  const system = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system' && !isCompressionNotice(m))

  const systemTokens = blockTokens(system)
  const blocks = groupIntoBlocks(rest)

  // Walk newest-first, keeping whole blocks while they fit. The newest block
  // is always kept — without it there is nothing for the model to answer —
  // even if it alone exceeds the budget; step 3 then trims it.
  const kept: MessageBlock[] = []
  let currentTokens = systemTokens
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (kept.length > 0 && currentTokens + block.tokens > maxTokens) break
    kept.unshift(block)
    currentTokens += block.tokens
  }

  // A transcript may not open with a tool result: its assistant turn is gone.
  while (kept.length > 0 && kept[0].messages[0].role === 'tool') {
    currentTokens -= kept[0].tokens
    kept.shift()
  }

  // Still over budget — trim tool results, oldest first.
  if (currentTokens > maxTokens) {
    outer: for (const block of kept) {
      for (let i = 0; i < block.messages.length; i++) {
        currentTokens -= truncateToolResult(block, i)
        if (currentTokens <= maxTokens) break outer
      }
    }
  }

  const compressed: ChatMessage[] = [...system]

  const droppedBlocks = blocks.length - kept.length
  if (droppedBlocks > 0) {
    compressed.push({
      role: 'user',
      content: `${COMPRESSION_NOTICE_PREFIX}${droppedBlocks} earlier exchange${droppedBlocks === 1 ? '' : 's'} were compressed to fit context window]`,
    })
  }

  for (const block of kept) {
    compressed.push(...block.messages)
  }

  return compressed
}
