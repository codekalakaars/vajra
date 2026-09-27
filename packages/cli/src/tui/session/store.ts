import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import type { AgentEvent } from '../../session/ui.js'
import { agentDisplay } from '../../session/ui.js'
import { clampReasoning, modelView, reasoningLevelsFor, type ModelView, type ReasoningEffort } from '../../models/catalog.js'

export type PromptKind = 'initial-first' | 'initial-reentry' | 'user' | 'confirm-plan' | 'feedback'

/**
 * How long to wait before painting buffered text.
 *
 * A short answer repaints at 20fps, which is smooth and far cheaper than the
 * token rate. A long one cannot: Ink's cost grows with the frame, and a 5.7KB
 * answer measured 69ms to redraw, so painting it 20 times a second would peg the
 * CPU and look like the flicker this whole exercise removed. The interval
 * therefore scales with how much is buffered, trading update rate for a frame
 * the terminal can actually absorb.
 */
export function streamFlushMs(pendingChars: number): number {
  if (pendingChars < 1_000) return 50
  if (pendingChars < 4_000) return 100
  return 200
}

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
    | {
        /** One tool call, written to the transcript so outliving the activity row. */
        kind: 'tool'
        callId: string
        tool: string
        summary: string
        /** Who ran it: "developer" or the task title. */
        agent: string
        status: 'running' | 'ok' | 'failed'
        ms?: number
        detail?: string
        expanded: boolean
      }
    | { kind: 'blank' }
  )

/**
 * How hard the model should think, and what this particular model accepts.
 *
 * The vocabulary is the model's, read from the catalog: a model that publishes
 * an effort list gets exactly that list, a toggle-only model gets `off`/`high`,
 * and a model that does not reason at all gets `off` and nothing else. `off`
 * sends no reasoning parameter, which is the only way to be sure a provider is
 * not reasoning behind our back. The type is re-exported from the catalog so
 * there is one definition of the wire vocabulary.
 */
export type { ReasoningEffort }
export { REASONING_EFFORTS } from '../../models/catalog.js'

/**
 * The conservative dial for a model the catalog cannot describe.
 *
 * Only used before the first fetch lands and for ids that never appear in one.
 * Four levels, because that is the vocabulary that has always worked; a model
 * that needs `xhigh` gets it the moment its facts arrive.
 */
const DEFAULT_REASONING_LEVELS: ReasoningEffort[] = ['off', 'low', 'medium', 'high']

/** The model-derived half of the state: its dial, and what it looks like. */
function modelFacts(model: string): { reasoningLevels: ReasoningEffort[]; modelInfo: ModelView | null } {
  return { reasoningLevels: reasoningLevelsFor(model), modelInfo: modelView(model) }
}

/** Accumulated provider usage for the footer meter. */
export interface UsageState {
  promptTokens: number
  completionTokens: number
  calls: number
  /** Prompt tokens of the most recent round ≈ current context size. */
  lastPromptTokens: number
}

export interface SessionState {
  /** Current settings — displayed in the header, mutable at runtime (/model, /dir). */
  model: string
  projectDir: string
  /** Mutable at runtime with ctrl-r or /reasoning, clamped to `reasoningLevels`. */
  reasoning: ReasoningEffort
  /** The dial for the current model, from the catalog. Never empty. */
  reasoningLevels: ReasoningEffort[]
  /** What the catalog knows about `model`, or null when it knows nothing. */
  modelInfo: ModelView | null
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
  usage: UsageState
}

const INITIAL: SessionState = {
  model: '',
  projectDir: '',
  reasoning: 'off',
  reasoningLevels: DEFAULT_REASONING_LEVELS,
  modelInfo: null,
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
  usage: { promptTokens: 0, completionTokens: 0, calls: 0, lastPromptTokens: 0 },
}

/** Observable session state. React subscribes via useSyncExternalStore. */
export class SessionStore {
  private listeners = new Set<() => void>()
  private state: SessionState
  private nextPromptId = 1
  private nextEntrySeq = 1
  /** Text buffered since the last flush — never rendered as-is. */
  private pendingStream = ''
  private pendingThinking = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(initial?: { model?: string; projectDir?: string }) {
    this.state = {
      ...INITIAL,
      ...initial,
      // Derived from the model, not stored independently: a level the model
      // cannot accept is a level the UI must not offer.
      ...modelFacts(initial?.model ?? ''),
    }
  }

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
    }, streamFlushMs(this.pendingStream.length + this.pendingThinking.length))
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
        const patch: Partial<SessionState> = {}
        if (event.usage) {
          const prev = this.state.usage
          patch.usage = {
            promptTokens: prev.promptTokens + event.usage.promptTokens,
            completionTokens: prev.completionTokens + event.usage.completionTokens,
            calls: prev.calls + 1,
            lastPromptTokens: event.usage.promptTokens,
          }
        }
        // Round finished — the row goes quiet until the next event.
        if (isDeveloper) {
          this.set({ ...patch, developer: undefined })
        } else {
          if (Object.keys(patch).length > 0) this.set(patch)
          this.updateWorkerActivity(agent.taskId, undefined)
        }
      }
      return
    }

    if (event.type === 'warning') {
      this.addEntry({ kind: 'warning', text: event.text })
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
      // The activity row is "what is happening now"; the transcript entry is
      // the durable record that survives the row going quiet.
      this.addEntry({
        kind: 'tool',
        callId: event.callId,
        tool: event.tool,
        summary: event.summary,
        agent: agentDisplay(agent),
        status: 'running',
        expanded: false,
      })
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
    } else if (agent.taskId) {
      const idx = this.state.tasks.findIndex(t => t.taskId === agent.taskId)
      if (idx >= 0) {
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
    }
    this.closeToolEntry(event.callId, event.ok, event.ms, event.detail)
  }

  /** Resolve the transcript entry a finished tool call opened. */
  private closeToolEntry(
    callId: string,
    ok: boolean,
    ms: number,
    detail?: string,
  ): void {
    const { entries } = this.state
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.kind !== 'tool' || entry.callId !== callId || entry.status !== 'running') continue
      const next = [...entries]
      next[i] = { ...entry, status: ok ? 'ok' : 'failed', ms, detail }
      this.set({ entries: next })
      return
    }
  }

  /** Expand/collapse a tool entry — called from the transcript focus. */
  toggleToolEntry(seq: number): void {
    const { entries } = this.state
    const idx = entries.findIndex(e => e.seq === seq && e.kind === 'tool')
    if (idx < 0) return
    const entry = entries[idx]
    if (entry.kind !== 'tool') return
    const next = [...entries]
    next[idx] = { ...entry, expanded: !entry.expanded }
    this.set({ entries: next })
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

  /** Apply a settings change (/model, /dir) so the header re-renders. */
  setSettings(patch: { model?: string; projectDir?: string; reasoning?: ReasoningEffort }): void {
    const model = patch.model ?? this.state.model
    const changingModel = patch.model !== undefined
    // A level that belonged to the old model is not a level the new one
    // accepts; keeping it would put a rejected value in the next request.
    const wanted = patch.reasoning ?? (changingModel ? this.state.reasoning : undefined)
    this.set({
      ...patch,
      ...(changingModel ? modelFacts(model) : {}),
      ...(wanted !== undefined ? { reasoning: clampReasoning(model, wanted) } : {}),
    })
  }

  /**
   * Re-read the model from the catalog.
   *
   * The catalog arrives after the store does — it is fetched, and the first
   * paint must not wait for it — so the shell calls this once the fetch lands.
   * Without it a session that started offline would keep showing the
   * conservative defaults and offering levels the model rejects.
   */
  refreshModelInfo(): void {
    if (!this.state.model) return
    const facts = modelFacts(this.state.model)
    this.set({ ...facts })
  }

  /**
   * Step to the next effort the current model accepts, wrapping.
   *
   * The list is the model's, so this is a two-level cycle for a toggle-only
   * model, a seven-step one for a model with `xhigh`, and a no-op for a model
   * that cannot reason — which is the point: ctrl-r can no longer produce a
   * request the gateway would reject.
   */
  cycleReasoning(): ReasoningEffort {
    const levels = this.state.reasoningLevels
    const at = levels.indexOf(this.state.reasoning)
    const next = levels[(at + 1) % levels.length] ?? 'off'
    this.set({ reasoning: next })
    return next
  }

  /**
   * Clear the interrupted flag between runs. It stays true for the rest of a
   * runSession (prompts auto-drain so the run can unwind), but the shell
   * starts the next run in a fresh state.
   */
  resetInterrupted(): void {
    if (this.state.interrupted) this.set({ interrupted: false })
  }
}
