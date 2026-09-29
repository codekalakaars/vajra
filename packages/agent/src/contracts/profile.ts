import type { AgentInstance, AgentLabel, AgentRole, ModelSettings, TaskScope } from './role.js'

/**
 * The one shape every LLM-backed role supplies, and the one the engine runs.
 *
 * The split is the whole point of the migration. The engine owns the model
 * conversation, tool dispatch, budgeting, cancellation and event reporting — the
 * part that was written twice in `developer.ts` and `execute.ts`. A profile owns
 * the prompt, the context, the tool catalog, and how a result is interpreted —
 * the part that is genuinely different per role.
 *
 * A profile cannot widen authority. `allowedTools` is an allowlist the dispatcher
 * intersects with the permission grant; a profile that lists `write_file` still
 * cannot write outside its task scope (plan boundary 2).
 */

/** What the host hands the engine for one run. */
export interface AgentRunInput {
  sessionId: string
  /** Chosen by the host per role (ADR-0010). Never read from config by the runtime. */
  model: ModelSettings
  /** Present when the run is bound to one task. */
  taskScope?: TaskScope
  /** Peer and plan context, pulled rather than pushed — see `CoordinationView`. */
  coordination?: CoordinationView
  signal: AbortSignal
  /** The conversation so far. Owned by the caller; the engine appends to it. */
  messages: unknown[]
  /** Where lifecycle events go. Typed, so a host decides how to show them. */
  onEvent?: (event: AgentEvent) => void
  /** Called with each streamed text delta, if the role streams prose. */
  onTextDelta?: (text: string) => void
  /** Called with each streamed reasoning delta, if the role surfaces it. */
  onThinkingDelta?: (text: string) => void
  /** The interrupt predicate, when it is more than the abort signal. */
  isInterrupted?: () => boolean
  /**
   * Role-specific inputs, read by `AgentProfile.buildContext`.
   *
   * `AgentRunInput` carries what every run needs; this carries what one role
   * needs. A Worker has no project index and a Manager has no directory to
   * scan, so neither belongs on the contract — but the Developer's context
   * builder cannot be written without them, and a contract that grew a field per
   * role would stop describing anything.
   */
  extra?: Record<string, unknown>
}

/** One role's behaviour. Everything role-specific lives here. */
export interface AgentProfile<Context = unknown> {
  readonly role: AgentRole
  /** Instructions. May explain a role; may never grant one. */
  buildSystemPrompt(context: Context): string
  /** Assemble the role's context. Runs before the first provider round. */
  buildContext(input: AgentRunInput): Promise<Context> | Context
  /** Tool names this role may be offered. An allowlist, not a permission. */
  readonly allowedTools: readonly string[]
  /**
   * Budgets for one run. The two shipped loops disagree — the Developer caps
   * tool calls, wall clock and iterations with a free-tool exemption, the Worker
   * caps tool calls alone — so this is an input rather than a constant.
   */
  readonly budget?: RunBudget
  /** Extra inputs the role needs that `AgentRunInput` does not carry. */
  readonly extra?: Record<string, unknown>
}

export interface RunBudget {
  maxToolCalls: number
  maxIterations?: number
  maxWallMs?: number
  /** Tools that do not count against `maxToolCalls`. */
  freeTools?: readonly string[]
}

/** What one run produced. */
export interface AgentResult<Out = unknown> {
  /** Attribution: which role, which model, which task. */
  instance: AgentInstance
  /** The role's own reading of the run. */
  outcome: Out
  /** The conversation as it stands, for the caller to persist or continue. */
  messages: unknown[]
  /** Why the run ended, when it did not end by producing a result. */
  stop?: 'completed' | 'interrupted' | 'budget-exhausted' | 'aborted'
}

/**
 * The plan, task status and peer handoffs a role may see.
 *
 * Pulled, not pushed: a Worker calls `get_team_status` to refresh during a long
 * run rather than having the runtime inject peer updates into its conversation.
 * That keeps context size and prompt caching predictable, and it is the reason
 * the runtime does not hand a Worker unrestricted peer transcripts
 * (plan boundary 7).
 */
export interface CoordinationView {
  /** The plan, or the slice of it this role is allowed to see. */
  plan?: { summary: string; tasks: readonly PlanTaskView[] }
  /** Current status of every task, or the subset visible to this role. */
  tasks(): readonly TaskStatusView[]
  /** Who currently holds a write lease on each path. */
  fileClaims(): Readonly<Record<string, string>>
  /** Structured notes published by completed peers. */
  handoffs(): readonly Handoff[]
}

export interface PlanTaskView {
  id: string
  title: string
  dependsOn: readonly string[]
  status: string
}

export interface TaskStatusView {
  id: string
  title: string
  status: string
  /** The paths this task declared, so a peer can see what it is touching. */
  readFile: readonly string[]
  writeFile: readonly string[]
  deleteFile: readonly string[]
  createDir: readonly string[]
}

export interface Handoff {
  taskId: string
  note: string
}

/**
 * The lifecycle events the engine reports.
 *
 * Structurally compatible with the CLI's existing `AgentEvent`, so a host can
 * consume both during the migration. `ms` and `elapsedMs` are wall-clock by
 * definition; everything else is deterministic for a given run, which is what
 * makes the replay fixtures in the CLI suite meaningful.
 */
export type AgentEvent =
  | { type: 'llm-start'; agent: AgentLabel; round: number }
  | {
      type: 'llm-end'
      agent: AgentLabel
      round: number
      ms: number
      budget?: number
      usage?: TokenUsage
    }
  | { type: 'tool-start'; agent: AgentLabel; callId: string; tool: string; summary: string }
  | {
      type: 'tool-end'
      agent: AgentLabel
      callId: string
      tool: string
      ok: boolean
      ms: number
      detail?: string
    }
  | { type: 'phase'; agent: AgentLabel; phase: AgentPhase }
  | { type: 'heartbeat'; agent: AgentLabel; elapsedMs: number }
  | { type: 'warning'; agent: AgentLabel; text: string }

export type AgentPhase = 'indexing' | 'planning' | 'executing' | 'validating' | 'inspecting'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
}
