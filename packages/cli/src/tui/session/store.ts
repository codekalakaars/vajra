import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import type { AgentEvent } from '../../session/ui.js'

export type PromptKind = 'initial-first' | 'initial-reentry' | 'user' | 'confirm-plan' | 'feedback'

/** Repaint cap for streamed text: 50ms ≈ 20fps, smooth and far fewer than a
 *  brisk token stream would otherwise trigger. */
const STREAM_FLUSH_MS = 50

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

/** What one agent is doing right now, for the in-place activity row. */
export interface AgentActivity {
  phase?: string
  tool: string
  summary: string
  since: number
  /** Completed tool calls collapse into a count so the pane cannot grow forever. */
  toolCount: number
}

export interface TaskView {
  taskId?: string
  title: string
  status: TaskStatus
  activity?: AgentActivity
}

/**
 * Stable identity, stamped by the store as each entry is appended.
 *
 * Entries are rendered once into scrollback by `<Static>`, which needs a key;
 * array position is not one, because the position shifts every time something is
 * committed.
 */
interface EntryBase {
  seq?: number
}

export type Entry = EntryBase &
  (
    | { kind: 'banner'; version: string }
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; text: string }
    | { kind: 'info' | 'success' | 'error' | 'warning'; text: string }
    | { kind: 'decision'; text: string }
    | { kind: 'plan'; plan: DeveloperPlan }
    | { kind: 'blank' }
  )

export interface SessionState {
  entries: Entry[]
  /** Live assistant text not yet flushed by finishLine(). */
  streaming: string
  /** Live thinking/reasoning text. */
  thinking: string
  prompt: PendingPrompt | null
  tasks: TaskView[]
  /** The developer row — the only agent with no task. */
  developer?: AgentActivity
  executionTotal: number
  executionIndex: number
  /** True after the user interrupts (Ctrl-C); prompts auto-drain with "exit". */
  interrupted: boolean
  /** runSession resolved — show the dismiss screen. */
  finished: boolean
  exitCode: number
  /** Bumped by heartbeats so elapsed counters actually tick. */
  tick: number
}

const INITIAL: SessionState = {
  entries: [],
  streaming: '',
  thinking: '',
  prompt: null,
  tasks: [],
  developer: undefined,
  executionTotal: 0,
  executionIndex: 0,
  interrupted: false,
  finished: false,
  exitCode: 0,
  tick: 0,
}

/** Observable session state. React subscribes via useSyncExternalStore. */
export class SessionStore {
  private listeners = new Set<() => void>()
  private state: SessionState = INITIAL
  private nextPromptId = 1
  private nextEntrySeq = 1
  /** Text buffered since the last flush — never rendered as-is. */
  private pendingStream = ''
  private pendingThinking = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null

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
    this.set({ entries: [...this.state.entries, { seq: this.nextEntrySeq++, ...entry }] })
  }

  /**
   * Model text arrives token by token, and every notification repaints the
   * whole session view. Repainting per token is what makes the TUI flicker, so
   * deltas are buffered and flushed on a short timer: the visible rate is capped
   * at ~20fps however fast the stream is. `commitStream` and `clearStream` flush
   * synchronously, so nothing is delayed or lost.
   */
  appendStream(text: string): void {
    this.pendingStream += text
    this.scheduleFlush()
  }

  appendThinking(text: string): void {
    this.pendingThinking += text
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPending()
    }, STREAM_FLUSH_MS)
  }

  private cancelFlush(): void {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private flushPending(): void {
    const stream = this.pendingStream
    const thinking = this.pendingThinking
    this.pendingStream = ''
    this.pendingThinking = ''
    if (!stream && !thinking) return
    this.set({
      ...(stream ? { streaming: this.state.streaming + stream } : {}),
      ...(thinking ? { thinking: this.state.thinking + thinking } : {}),
    })
  }

  commitStream(): void {
    this.cancelFlush()
    this.flushPending()
    const { streaming, thinking, entries } = this.state
    if (!streaming && !thinking) return
    const next: Entry[] = [...entries]
    if (streaming) next.push({ seq: this.nextEntrySeq++, kind: 'assistant', text: streaming })
    this.set({ entries: next, streaming: '', thinking: '' })
  }

  clearStream(): void {
    this.cancelFlush()
    this.pendingStream = ''
    this.pendingThinking = ''
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
      tasks: plan.tasks.map(t => ({
        taskId: t.id,
        title: t.title,
        status: 'pending' as TaskStatus,
      })),
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

  /**
   * Fold a sub-task event into the row it belongs to. One row per active
   * agent — interleaved events from four workers are attributed by
   * `taskId`, never appended as a flat log.
   */
  applyAgentEvent(event: AgentEvent): void {
    const { agent } = event
    const isDeveloper = agent.role === 'developer'

    if (event.type === 'heartbeat') {
      // No state change, but re-render so elapsed counters move.
      this.set({ tick: this.state.tick + 1 })
      return
    }

    if (event.type === 'phase') {
      const activity: AgentActivity = {
        phase: event.phase,
        tool: '',
        summary: '',
        since: Date.now(),
        toolCount: 0,
      }
      if (isDeveloper) this.set({ developer: activity })
      else this.updateWorkerActivity(agent.taskId, activity)
      return
    }

    if (event.type === 'llm-start' || event.type === 'llm-end') {
      if (event.type === 'llm-start') {
        // The count carries across rounds — it is a running total for the row,
        // not a per-round one, or a long task would keep restarting at 1.
        const toolCount = (isDeveloper ? this.state.developer?.toolCount : undefined) ?? 0
        const activity: AgentActivity = {
          tool: 'thinking',
          summary: `round ${event.round}`,
          since: Date.now(),
          toolCount,
        }
        if (isDeveloper) this.set({ developer: activity })
        else this.updateWorkerActivity(agent.taskId, activity)
      } else {
        // Round finished — the row goes quiet until the next event.
        if (isDeveloper) this.set({ developer: undefined })
        else this.updateWorkerActivity(agent.taskId, undefined)
      }
      return
    }

    if (event.type === 'tool-start') {
      const toolCount = (isDeveloper ? this.state.developer?.toolCount : undefined) ?? 0
      const idx = isDeveloper ? -1 : this.state.tasks.findIndex(t => t.taskId === agent.taskId)
      const activity: AgentActivity = {
        tool: event.tool,
        summary: event.summary,
        since: Date.now(),
        toolCount: idx >= 0 ? (this.state.tasks[idx].activity?.toolCount ?? 0) : toolCount,
      }
      if (isDeveloper) this.set({ developer: activity })
      else this.updateWorkerActivity(agent.taskId, activity)
      return
    }

    // tool-end
    if (isDeveloper) {
      const previous = this.state.developer
      this.set({
        developer: previous
          ? { ...previous, toolCount: previous.toolCount + 1, tool: '', summary: '' }
          : undefined,
      })
      return
    }
    if (!agent.taskId) return
    const idx = this.state.tasks.findIndex(t => t.taskId === agent.taskId)
    if (idx < 0) return
    const previous = this.state.tasks[idx].activity
    const tasks = [...this.state.tasks]
    tasks[idx] = {
      ...tasks[idx],
      activity: previous
        ? { ...previous, toolCount: previous.toolCount + 1, tool: '', summary: '' }
        : undefined,
    }
    this.set({ tasks })
  }

  private updateWorkerActivity(
    taskId: string | undefined,
    activity: AgentActivity | undefined,
  ): void {
    if (!taskId) return
    const idx = this.state.tasks.findIndex(t => t.taskId === taskId)
    if (idx < 0) return
    const tasks = [...this.state.tasks]
    tasks[idx] = { ...tasks[idx], activity }
    this.set({ tasks })
  }

  setFinished(exitCode: number): void {
    this.set({ finished: true, exitCode, prompt: null })
  }
}
