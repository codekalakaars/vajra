/**
 * The wire between the Node agent and this Bun UI: one JSON object per line,
 * both directions, over the child's stdio.
 *
 * The server sends whole snapshots rather than deltas. A local pipe moves a
 * few kilobytes in microseconds, and a snapshot cannot drift out of sync with
 * the store the way an event log can — the UI is a pure function of `state`,
 * so a dropped or reordered line is impossible and a duplicated one is free.
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
   */
  | { t: 'pick'; title: string; options: { value: string; label: string }[]; initial?: number }
  | { t: 'clear' }
  | { t: 'exit'; code: number }

export type ClientMessage =
  | { t: 'ready'; cols: number; rows: number }
  /** A submitted line: a task, or a slash command the UI did not resolve. */
  | { t: 'submit'; value: string }
  /** A command chosen from the palette, or a hotkey. `arg` is the argument. */
  | { t: 'slash'; name: string; arg?: string }
  /**
   * A row was chosen, or the picker was dismissed. `null` is the escape: the
   * host is waiting on this promise, and a picker the user closed has to answer
   * it or the command that opened it never finishes.
   */
  | { t: 'pick'; value: string | null }
  | { t: 'signal'; name: 'interrupt' }
  | { t: 'bye' }

/** Parse one NDJSON line. Returns null for anything unreadable. */
export function decode(line: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(line) as ClientMessage
    return typeof parsed === 'object' && parsed !== null && typeof parsed.t === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Filter commands by what has been typed after the `/`. A match is a
 * subsequence of the name, so `/mdl` finds `/model` — the same forgiving
 * behaviour OpenCode has, and the reason a prefix-only filter feels broken.
 */
export function matchCommands(commands: CommandSpec[], query: string): CommandSpec[] {
  const q = query.toLowerCase()
  if (q === '') return commands
  const scored: { command: CommandSpec; score: number }[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    let cursor = 0
    for (const ch of name) {
      if (ch === q[cursor]) cursor += 1
      if (cursor === q.length) break
    }
    if (cursor === q.length) scored.push({ command, score: name.startsWith(q) ? 0 : 1 })
  }
  return scored.sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name)).map(s => s.command)
}
