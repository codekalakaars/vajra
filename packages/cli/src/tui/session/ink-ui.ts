import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import type { SessionUI, TaskEvent } from '../../session/ui.js'
import { SessionStore, type PromptKind } from './store.js'

/**
 * SessionUI backed by the Ink session store. Prompt methods park a resolver
 * in the store until ChatInput submits; output methods append transcript
 * entries. No direct stdin/stdout access.
 */
export class InkSessionUI implements SessionUI {
  constructor(
    private readonly store: SessionStore,
    private readonly version: string,
  ) {}

  banner(): void {
    this.store.addEntry({ kind: 'banner', version: this.version })
  }

  info(message: string): void {
    this.store.addEntry({ kind: 'info', text: message })
  }

  success(message: string): void {
    this.store.addEntry({ kind: 'success', text: message })
  }

  error(message: string): void {
    this.store.addEntry({ kind: 'error', text: message })
  }

  warning(message: string): void {
    this.store.addEntry({ kind: 'warning', text: message })
  }

  newline(): void {
    this.store.addEntry({ kind: 'blank' })
  }

  onTextDelta(text: string): void {
    this.store.appendStream(text)
  }

  onThinkingDelta(text: string): void {
    this.store.appendThinking(text)
  }

  finishLine(): void {
    this.store.commitStream()
  }

  discardBuffer(): void {
    this.store.clearStream()
  }

  askInitialTask(kind: 'first' | 'reentry'): Promise<string> {
    return this.store.ask(kind === 'first' ? 'initial-first' : 'initial-reentry')
  }

  askUserMessage(): Promise<string> {
    return this.store.ask('user')
  }

  showPlan(plan: DeveloperPlan): void {
    this.store.setPlanTasks(plan)
    this.store.addEntry({ kind: 'plan', plan })
  }

  async askConfirmPlan(): Promise<'y' | 'n'> {
    const answer = await this.store.ask('confirm-plan')
    const lower = answer.trim().toLowerCase()
    // D8: confirmation is [y/N] — anything other than yes rejects.
    return lower === 'y' || lower === 'yes' ? 'y' : 'n'
  }

  askRejectFeedback(): Promise<string> {
    return this.store.ask('feedback')
  }

  onTaskEvent(event: TaskEvent): void {
    this.store.applyTaskEvent(event)
  }
}

export type { PromptKind }
