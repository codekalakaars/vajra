/**
 * The wire between the Node agent and the Bun UI: one JSON object per line.
 *
 * The server sends whole snapshots rather than deltas. A local pipe moves a few
 * kilobytes in microseconds, and a snapshot cannot drift out of sync with the
 * store the way an event log can — the screen is a pure function of `state`, so
 * a duplicated line is free and a missing one cannot happen.
 *
 * This file is duplicated in `packages/tui/src/protocol.ts`. It is the contract
 * between two processes that are built and shipped separately, and a shared
 * package would mean a build step in the middle of the hot path; the types
 * cannot drift silently because both sides are checked against their own copy
 * by the same test.
 */

export interface TaskView {
  title: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  activity?: { tool: string; summary: string; since: number; toolCount?: number }
}

export type Entry =
  | { kind: 'banner'; version: string }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'info' | 'success' | 'error' | 'warning'; text: string }
  | { kind: 'decision'; text: string }
  | { kind: 'plan'; title: string; steps: string[] }
  | {
      kind: 'tool'
      tool: string
      summary: string
      agent: string
      status: 'running' | 'ok' | 'failed'
      ms?: number
      detail?: string
      expanded: boolean
    }
  | { kind: 'blank' }

export interface Usage {
  promptTokens: number
  completionTokens: number
  calls: number
  lastPromptTokens: number
}

/**
 * How hard the model should think, and the levels this model actually accepts.
 *
 * The vocabulary is the model's, read from the live catalog and sent down with
 * the snapshot: a model that publishes an effort list gets exactly that list, a
 * toggle-only model gets `off`/`high`, and a model that cannot reason gets
 * `off` alone. `off` sends no reasoning parameter at all.
 */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The fallback dial, for a screen that has not been told the model's yet. */
export const REASONING_LEVELS: ReasoningEffort[] = ['off', 'low', 'medium', 'high']

/** How a model wants reasoning controlled, as the catalog reports it. */
export type ReasoningMode = 'none' | 'toggle' | 'effort' | 'budget'

/** Reachability, as the gateway's own listing reported it. */
export type ModelStatus = 'available' | 'unavailable' | 'unknown'

/**
 * What the screen draws about the current model. A flat subset of the Node
 * catalog's `ModelInfo`: snapshots are republished constantly during a stream,
 * so this carries the numbers the screen reads and nothing else.
 */
export interface ModelView {
  id: string
  name: string
  /** Context window in tokens; the usage meter measures against this. */
  context: number
  reasoning: boolean
  reasoningMode: ReasoningMode
  levels: ReasoningEffort[]
  cost: { input: number; output: number; cacheRead: number }
  status: ModelStatus
  statusDetail?: string
  toolCall: boolean
  description?: string
}

/** Everything the screen draws. Mirrors the Node store's public shape. */
export interface UiState {
  version: string
  model: string
  projectDir: string
  entries: Entry[]
  /** Live assistant text, not yet flushed into `entries`. */
  streaming: string
  thinking: string
  /** Non-null while the agent is waiting for a line of input. */
  prompt: { kind: string; label: string } | null
  tasks: TaskView[]
  executionIndex: number
  executionTotal: number
  interrupted: boolean
  usage: Usage
  reasoning: ReasoningEffort
  /** The dial for `model`, from the catalog. Never empty. */
  reasoningLevels: ReasoningEffort[]
  /** What the catalog knows about `model`; null while it knows nothing. */
  modelInfo: ModelView | null
  /** Bumped on every heartbeat so elapsed counters tick. */
  tick: number
}

export interface CommandSpec {
  name: string
  summary: string
}

export type ServerMessage =
  | { t: 'state'; state: UiState }
  | { t: 'commands'; commands: CommandSpec[] }
  /**
   * A picker is open: the UI shows a list and sends back `{ t: 'pick' }`.
   *
   * `initial` is where the cursor starts — the model picker's list runs to
   * dozens of rows in catalog order, and opening on row 0 of a list the user
   * did not ask for is a list they have to scroll to find themselves in.
   *
   * `deletable` is permission, not presentation: it says the host will act on a
   * delete for this list, and the UI decides how to say so. A list whose rows
   * are ids has to be filterable, and `d` is a character in half of them, so the
   * chord for delete is the UI's business too.
   */
  | {
      t: 'pick'
      title: string
      options: { value: string; label: string }[]
      initial?: number
      deletable?: boolean
      /**
       * The list takes a value the user types rather than one they choose.
       *
       * The client owns the affordance — a row of its own above the
       * recommendations, and a draft line once that row is taken — so the host
       * sends the flag and validates whatever comes back. A list of paths that
       * can only be chosen from is a list that can only be chosen from.
       */
      editable?: boolean
      /**
       * More paths to narrow, shown only while a path is being typed.
       *
       * Sent once and filtered on this side as the draft changes: the host is
       * blocked waiting for the answer, so asking it per keystroke would ask
       * the one process that cannot answer. Two levels below home is what makes
       * `vj` reach `~/projects/vajra`, which is the whole point of typing
       * instead of choosing.
       */
      candidates?: { value: string; label: string }[]
    }
  | { t: 'clear' }
  | { t: 'exit'; code: number }

export type ClientMessage =
  | { t: 'ready'; cols: number; rows: number }
  /** A submitted line: a task, or a slash command the UI did not resolve. */
  | { t: 'submit'; value: string }
  /** A command chosen from the palette, or a hotkey. `arg` is the argument. */
  | { t: 'slash'; name: string; arg?: string }
  /**
   * A row was chosen, deleted, or the picker was dismissed.
   *
   * `null` is the escape: the host is waiting on this promise, and a picker the
   * user closed has to answer it or the command that opened it never finishes.
   * `action` distinguishes "I want this" from "this should not exist" — the same
   * row, two intents, and only the host knows what the second one means.
   */
  | { t: 'pick'; value: string | null; action?: 'delete' }
  /**
   * Ctrl-C. The first press interrupts the run; a second, while the first is
   * still being acted on, means "stop asking" — the same gesture with a
   * different intent, which is why it is one message with a flag rather than two
   * names the host has to know the order of.
   */
  | { t: 'signal'; name: 'interrupt'; force?: boolean }
  | { t: 'bye' }

