import type { FilePermissions } from '@codekalakaars/vajra-protocol'

/**
 * What a role is, and what an instance of one is.
 *
 * Three names that used to collide, kept apart on purpose (the plan's
 * Readability Rules):
 *
 * - `AgentRole` — which role. Prompt text cannot grant a role, so this is a
 *   type the runtime branches on, never a value read from a model response.
 * - `AgentProfile` — how a role behaves: its prompt, its context, its tools.
 *   Defined in `profile.ts`.
 * - `AgentInstance` — one running agent, recorded so a result can be attributed
 *   to a model. ADR-0010 requires the attribution; the old `AgentState` in the
 *   CLI had no `model` field and therefore recorded none.
 */

export type AgentRole = 'developer' | 'manager' | 'worker'

/**
 * The role name as it appears on the wire and in the store today.
 *
 * `master` is the shipped spelling. Renaming it to `manager` is step 6 of the
 * migration, and until every consumer has switched the old name has to keep
 * working — a wire alias, not a second role.
 */
export type WireRole = 'developer' | 'master' | 'manager' | 'worker'

/** Which role an event or a piece of state belongs to. */
export interface AgentLabel {
  role: AgentRole
  /** Present for a Worker, and for a Manager inspecting on a task's behalf. */
  taskId?: string
  title?: string
}

/**
 * The model an agent runs on, supplied by the host.
 *
 * A model's capability grants no authority (ADR-0010): choosing a weaker model
 * narrows what a role does well and never widens what it may do. That is why
 * this is settings and not a policy input — nothing in the runtime reads it to
 * decide what a call is allowed.
 */
export interface ModelSettings {
  /** A `zen/*` or `go/*` id — the only forms the gateway routes. */
  model: string
  /** How hard the model should think, clamped by what the model accepts. */
  reasoningEffort?: ReasoningEffort
}

/**
 * The reasoning vocabulary, which is the model's rather than ours.
 *
 * `off` is ours and never goes on the wire: it means "send no reasoning
 * parameter", which is the only way to be sure a provider is not reasoning
 * behind our back.
 */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * One running agent, recorded for attribution.
 *
 * Created per `run` and carried on the result, so every answer can be traced to
 * the role and the model that produced it. ADR-0010 lists this as an open
 * question; the answer here is that it is recorded, not inferred after the fact.
 */
export interface AgentInstance {
  id: string
  sessionId: string
  role: AgentRole
  /** The single task this agent is executing, if it is a Worker. */
  currentTaskId?: string
  /** The model backing this agent, as supplied by the host. */
  model: string
  startedAt: number
  endedAt?: number
}

/** Which paths a task may touch, and how. */
export interface TaskScope {
  taskId: string
  projectDir: string
  /** Declared inputs: shared read leases, and the evidence a plan is built on. */
  readFile: readonly string[]
  /** Declared outputs: exclusive write leases, and the rollback set. */
  writeFile: readonly string[]
  deleteFile: readonly string[]
  createDir: readonly string[]
  /** Per-path permissions, when the task carries them. */
  permissions?: Record<string, FilePermissions>
}

/**
 * What a role is permitted to do, derived by the runtime and never by a prompt.
 *
 * A profile's `allowedTools` is an allowlist of tool *names*; this is the
 * separate, path-level answer for the task in flight. The two are deliberately
 * different types: conflating them is how a prompt ends up with authority.
 */
export interface PermissionGrant {
  role: AgentRole
  /** Tool names this role may have dispatched on its behalf. */
  tools: readonly string[]
  /** Per-path permissions for the current task, if the task is scoped. */
  paths?: Record<string, FilePermissions>
  /** Tools this role may not call whatever the task allows. */
  denied?: readonly string[]
}
