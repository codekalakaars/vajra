import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'

export type PromptKind = 'initial-first' | 'initial-reentry' | 'user' | 'confirm-plan' | 'feedback'

export const PROMPT_LABELS: Record<PromptKind, string> = {
  'initial-first': 'What would you like me to work on?',
  'initial-reentry': 'Please enter a task (or type "exit" to quit):',
  user: 'You:',
  'confirm-plan': '? Confirm plan? [y/N]',
  feedback: 'Feedback:',
}

export interface PendingPrompt {
  id: number
  kind: PromptKind
  label: string
  resolve: (value: string) => void
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface TaskView {
  title: string
  status: TaskStatus
}

export type Entry =
  | { kind: 'banner'; version: string }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'info' | 'success' | 'error' | 'warning'; text: string }
  | { kind: 'decision'; text: string }
  | { kind: 'plan'; plan: DeveloperPlan }
  | { kind: 'blank' }

export interface SessionState {
  entries: Entry[]
  /** Live assistant text not yet flushed by finishLine(). */
  streaming: string
  /** Live thinking/reasoning text. */
  thinking: string
  prompt: PendingPrompt | null
  tasks: TaskView[]
  executionTotal: number
  executionIndex: number
  /** True after the user interrupts (Ctrl-C); prompts auto-drain with "exit". */
  interrupted: boolean
  /** runSession resolved — show the dismiss screen. */
  finished: boolean
  exitCode: number
}

const INITIAL: SessionState = {
  entries: [],
  streaming: '',
  thinking: '',
  prompt: null,
  tasks: [],
  executionTotal: 0,
  executionIndex: 0,
  interrupted: false,
  finished: false,
  exitCode: 0,
}

/** Observable session state. React subscribes via useSyncExternalStore. */
export class SessionStore {
  private listeners = new Set<() => void>()
  private state: SessionState = INITIAL
  private nextPromptId = 1

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): SessionState => this.state

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  addEntry(entry: Entry): void {
    this.set({ entries: [...this.state.entries, entry] })
  }

  appendStream(text: string): void {
    this.set({ streaming: this.state.streaming + text })
  }

  appendThinking(text: string): void {
    this.set({ thinking: this.state.thinking + text })
  }

  commitStream(): void {
    const { streaming, thinking, entries } = this.state
    if (!streaming && !thinking) return
    const next: Entry[] = [...entries]
    if (streaming) next.push({ kind: 'assistant', text: streaming })
    this.set({ entries: next, streaming: '', thinking: '' })
  }

  clearStream(): void {
    if (!this.state.streaming && !this.state.thinking) return
    this.set({ streaming: '', thinking: '' })
  }

  /** Begin a prompt; resolves when the user submits. */
  ask(kind: PromptKind): Promise<string> {
    return new Promise<string>(resolve => {
      this.set({
        prompt: { id: this.nextPromptId++, kind, label: PROMPT_LABELS[kind], resolve },
      })
      // Interrupted sessions drain any new prompt with "exit" so runSession
      // can unwind instead of hanging on the await.
      if (this.state.interrupted) {
        queueMicrotask(() => this.submitPrompt('exit'))
      }
    })
  }

  submitPrompt(value: string): void {
    const prompt = this.state.prompt
    if (!prompt) return
    const trimmed = value.trim()
    if (prompt.kind === 'confirm-plan') {
      const yes = trimmed.toLowerCase() === 'y' || trimmed.toLowerCase() === 'yes'
      this.addEntry({ kind: 'decision', text: yes ? '✓ Plan confirmed' : '✗ Plan rejected' })
    } else if (trimmed) {
      this.addEntry({ kind: 'user', text: trimmed })
    }
    this.set({ prompt: null })
    prompt.resolve(trimmed)
  }

  setPlanTasks(plan: DeveloperPlan): void {
    this.set({
      tasks: plan.tasks.map(t => ({ title: t.title, status: 'pending' as TaskStatus })),
      executionTotal: plan.tasks.length,
      executionIndex: 0,
    })
  }

  applyTaskEvent(event: {
    type: 'start' | 'done' | 'failed' | 'skipped' | 'retry' | 'no-changes'
    title: string
    index?: number
    total?: number
    attempt?: number
    max?: number
  }): void {
    const statusFor: Record<string, TaskStatus> = {
      done: 'done',
      failed: 'failed',
      skipped: 'skipped',
    }
    const tasks = this.state.tasks.map(t =>
      t.title === event.title && statusFor[event.type]
        ? { ...t, status: statusFor[event.type] }
        : t,
    )
    const patch: Partial<SessionState> = { tasks }
    if (event.type === 'start' && event.index && event.total) {
      patch.executionIndex = event.index
      patch.executionTotal = event.total
      const idx = this.state.tasks.findIndex(t => t.title === event.title)
      if (idx >= 0) tasks[idx] = { ...tasks[idx], status: 'running' }
    }
    this.set(patch)
  }

  markInterrupted(): void {
    this.set({ interrupted: true })
    // If a prompt is waiting, drain it so runSession can observe the exit.
    if (this.state.prompt) {
      queueMicrotask(() => this.submitPrompt('exit'))
    }
  }

  setFinished(exitCode: number): void {
    this.set({ finished: true, exitCode, prompt: null })
  }
}
