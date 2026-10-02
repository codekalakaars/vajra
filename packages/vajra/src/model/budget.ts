import type { ChatMessage } from './chat.js'
import { getModelLimit } from './context-window.js'

/**
 * How full a model's window is, measured where it can be and estimated where it
 * cannot.
 *
 * The provider's `prompt_tokens` after a round is the true size of what was
 * sent, so every decision that can wait for a round uses it. Before a round —
 * sizing a pack, deciding whether a trim is needed — only characters are known,
 * so they are converted with a ratio learnt from the rounds already measured:
 * a moving average of characters per token, seeded at 4 and shared by every
 * Worker on the same model in this process. A model whose tokenizer packs code
 * densely stops being under-counted after a few rounds.
 */

/** Characters per token before anything has been measured. */
const SEED_RATIO = 4
/** Weight of the newest measurement in the moving average. */
const SMOOTHING = 0.3

const ratios = new Map<string, number>()

/** The characters a message contributes to a prompt, tool-call arguments included. */
export function messageChars(message: ChatMessage): number {
  let chars = message.content ? message.content.length : 0
  for (const call of message.tool_calls ?? []) {
    chars += call.function.name.length + call.function.arguments.length
  }
  // Role, separators and the provider's framing: a few tokens per message.
  return chars + 16
}

export function promptChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0)
}

export class ContextBudget {
  readonly window: number

  constructor(readonly model: string) {
    this.window = getModelLimit(model)
  }

  /** Characters per token for this model, as calibrated so far. */
  get ratio(): number {
    return ratios.get(this.model) ?? SEED_RATIO
  }

  /** Learn from a measured round: the characters sent, and the tokens the provider counted. */
  observe(chars: number, promptTokens: number): void {
    if (!(chars > 0) || !(promptTokens > 0)) return
    const measured = chars / promptTokens
    // A ratio outside this range is a misreport, not a tokenizer.
    if (measured < 1 || measured > 12) return
    ratios.set(this.model, this.ratio + SMOOTHING * (measured - this.ratio))
  }

  /** Estimated tokens for some text or characters. */
  tokens(charsOrText: number | string): number {
    const chars = typeof charsOrText === 'string' ? charsOrText.length : charsOrText
    return Math.ceil(chars / this.ratio)
  }

  /** Estimated tokens for a whole prompt. */
  estimate(messages: readonly ChatMessage[]): number {
    return this.tokens(promptChars(messages))
  }

  /** A token count as a share of the window, 0..1 and beyond. */
  share(tokens: number): number {
    return this.window > 0 ? tokens / this.window : 0
  }
}

/** Forget every calibration. For tests. */
export function resetCalibration(): void {
  ratios.clear()
}
