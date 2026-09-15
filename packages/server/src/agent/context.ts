// Context window optimization utilities.
//
// Provides token-aware compression for chat messages to prevent
// exceeding LLM context limits while preserving important information.

import type { ChatMessage } from './providers/types.js'

// Approximate tokens per character (conservative estimate)
const CHARS_PER_TOKEN = 4

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

  // Check for partial match
  for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
    if (model.includes(key)) {
      return limit
    }
  }

  return MODEL_LIMITS.default
}

/**
 * Compress messages to fit within token limit.
 *
 * Strategy:
 * 1. Always keep system prompt
 * 2. Always keep last N messages (recent context)
 * 3. Summarize older messages
 * 4. Compress tool results
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

  const compressed: ChatMessage[] = []
  let currentTokens = 0

  // Find system prompt (usually first message)
  const systemIdx = messages.findIndex(m => m.role === 'system')
  if (systemIdx >= 0) {
    compressed.push(messages[systemIdx])
    currentTokens += estimateTokens(messages[systemIdx])
  }

  // Keep last 6 messages for recent context
  const recentCount = 6
  const recentStart = Math.max(0, messages.length - recentCount)
  const recentMessages = messages.slice(recentStart)

  // Add recent messages
  for (const msg of recentMessages) {
    if (compressed.includes(msg)) continue
    const msgTokens = estimateTokens(msg)
    if (currentTokens + msgTokens <= maxTokens) {
      compressed.push(msg)
      currentTokens += msgTokens
    }
  }

  // If still over limit, compress older tool results
  if (currentTokens > maxTokens) {
    for (let i = 0; i < compressed.length; i++) {
      const msg = compressed[i]
      if (msg.role === 'tool' && msg.content && msg.content.length > 500) {
        // Truncate long tool results
        const truncated = msg.content.slice(0, 500) + '\n... (truncated)'
        const savedTokens = estimateTokens(msg) - estimateTokens({ ...msg, content: truncated })
        compressed[i] = { ...msg, content: truncated }
        currentTokens -= savedTokens

        if (currentTokens <= maxTokens) break
      }
    }
  }

  // Add summary message if we compressed
  if (compressed.length < messages.length) {
    const skippedCount = messages.length - compressed.length
    compressed.splice(1, 0, {
      role: 'user',
      content: `[System: ${skippedCount} earlier messages were compressed to fit context window]`,
    })
  }

  return compressed
}

/**
 * Compress a single long message.
 */
export function compressMessage(message: ChatMessage, maxLength: number = 2000): ChatMessage {
  if (!message.content || message.content.length <= maxLength) {
    return message
  }

  // For tool results, keep beginning and end
  if (message.role === 'tool') {
    const halfLength = Math.floor(maxLength / 2)
    const truncated = message.content.slice(0, halfLength) +
      '\n\n... (truncated) ...\n\n' +
      message.content.slice(-halfLength)
    return { ...message, content: truncated }
  }

  // For other messages, just truncate
  return { ...message, content: message.content.slice(0, maxLength) + '...' }
}
