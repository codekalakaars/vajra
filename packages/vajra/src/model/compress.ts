import { type ChatMessage, 
} from './chat.js'
import { getModelLimit } from './context-window.js'

// Approximate tokens per character (conservative estimate)
const CHARS_PER_TOKEN = 4

function estimateTokens(message: ChatMessage): number {
  let tokens = 0
  if (message.content) {
    tokens += Math.ceil(message.content.length / CHARS_PER_TOKEN)
  }
  if (message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      tokens += Math.ceil(toolCall.function.name.length / CHARS_PER_TOKEN)
      tokens += Math.ceil(toolCall.function.arguments.length / CHARS_PER_TOKEN)
    }
  }
  tokens += 4 // Overhead per message
  return tokens
}

/**
 * Compress history to fit the model context window (E5).
 *
 * Walks complete assistant(+tool_calls) + tool-result units so a pruned
 * tool result never leaves its parent assistant dangling, and vice versa.
 * Incomplete units (assistant tool_calls with missing results) are always
 * dropped, even when the history fits without compression.
 *
 * `pinned` leading messages are kept like the system prompt, whatever their
 * role: a Worker's first user message is its task, and dropping it to make
 * room would leave the Worker working on nothing it can see.
 */
export function compressMessages(
  messages: ChatMessage[],
  model: string,
  reserveTokens: number = 2000,
  pinned: number = 0,
): ChatMessage[] {
  const maxTokens = getModelLimit(model) - reserveTokens

  // Split into units: system alone; assistant with tool_calls + its tool results;
  // other messages as single-message units. Incomplete units are dropped here.
  const units: ChatMessage[][] = []
  const pinnedUnits = new Set<ChatMessage[]>()
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (i < pinned) {
      const unit = [msg]
      pinnedUnits.add(unit)
      units.push(unit)
      i++
      continue
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const unit: ChatMessage[] = [msg]
      const toolIds = new Set(msg.tool_calls.map(tc => tc.id))
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') {
        unit.push(messages[j])
        toolIds.delete(messages[j].tool_call_id ?? '')
        j++
      }
      // Drop incomplete units (missing tool results) rather than emit dangling
      // tool_calls that providers reject.
      if (toolIds.size === 0) {
        units.push(unit)
        i = j
        continue
      }
      i++
      continue
    }
    units.push([msg])
    i++
  }

  const isKept = (u: ChatMessage[]): boolean => pinnedUnits.has(u) || u[0]?.role === 'system'
  const systemUnits = units.filter(isKept)
  const rest = units.filter(u => !isKept(u))

  const all: ChatMessage[] = [...systemUnits, ...rest].flat()
  const totalTokens = all.reduce((sum, msg) => sum + estimateTokens(msg), 0)
  if (totalTokens <= maxTokens) return all

  const compressed: ChatMessage[] = []
  let currentTokens = 0

  for (const unit of systemUnits) {
    for (const msg of unit) {
      compressed.push(msg)
      currentTokens += estimateTokens(msg)
    }
  }

  // Keep whole units from the end (most recent context).
  const keptUnits: ChatMessage[][] = []
  for (let k = rest.length - 1; k >= 0; k--) {
    const unit = rest[k]
    const unitTokens = unit.reduce((s, m) => s + estimateTokens(m), 0)
    if (currentTokens + unitTokens > maxTokens) break
    keptUnits.unshift(unit)
    currentTokens += unitTokens
  }

  for (const unit of keptUnits) {
    for (const msg of unit) compressed.push(msg)
  }

  // Still over budget (e.g. huge system or one huge tool result): truncate
  // tool payloads rather than break units.
  if (currentTokens > maxTokens) {
    for (let idx = 0; idx < compressed.length; idx++) {
      const msg = compressed[idx]
      if (msg.role === 'tool' && msg.content && msg.content.length > 500) {
        const truncated = msg.content.slice(0, 500) + '\n... (truncated)'
        const savedTokens = estimateTokens(msg) - estimateTokens({ ...msg, content: truncated })
        compressed[idx] = { ...msg, content: truncated }
        currentTokens -= savedTokens
        if (currentTokens <= maxTokens) break
      }
    }
  }

  return compressed
}
