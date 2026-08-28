// Payload shapes for the concrete RPC methods and push events this app uses.
//
// Shapes that mirror vajra-native's own types (PermissionsConfig,
// ProjectFileEntry, SandboxResult) are hand-duplicated rather than imported —
// this package must stay loadable in a browser bundle, and vajra-native pulls
// in a `.node` addon loader that can't run there.

export interface FilePermissions {
  read: boolean
  write: boolean
  edit: boolean
  delete: boolean
}

export interface PermissionsConfig {
  version: number
  default: FilePermissions
  files: Record<string, FilePermissions>
}

export interface ProjectFileEntry {
  name: string
  path: string
  isDir: boolean
  isMasked: boolean
}

export type PlanStepStatus = 'pending' | 'active' | 'done' | 'skipped'

export interface PlanStep {
  index: number
  title: string
  status: PlanStepStatus
}

export type SessionStatus = 'starting' | 'planning' | 'executing' | 'done' | 'failed' | 'stopped'

// ---- RPC method params/results ----

export interface ProjectScanParams {
  projectDir: string
}
export type ProjectScanResult = ProjectFileEntry[]

export interface ProjectLoadPermissionsParams {
  projectDir: string
}
export type ProjectLoadPermissionsResult = PermissionsConfig

export interface ProjectSavePermissionsParams {
  projectDir: string
  config: PermissionsConfig
}
export type ProjectSavePermissionsResult = { ok: true }

export interface SessionCreateParams {
  projectDir: string
  permissions: PermissionsConfig
  task: string
  model: string
  /**
   * Must originate from an explicit user confirmation in the UI, never a
   * default — see the security invariant checklist in the project plan.
   */
  allowUnenforced?: boolean
}
export interface SessionCreateResult {
  sessionId: string
}

export type SessionListResult = Array<{
  id: string
  projectDir: string
  task: string
  status: SessionStatus
  createdAt: number
}>

export interface SessionAttachParams {
  sessionId: string
}

export interface AttachMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  toolName?: string
  toolCallId?: string
  toolArgs?: string
  toolResult?: string
  createdAt: number
}

export interface SessionAttachResult {
  session: SessionListResult[number]
  plan: PlanStep[]
  sandbox: SandboxStatusPayload | null
  messages: AttachMessage[]
  activeStep: number | null
}

export interface SessionStopParams {
  sessionId: string
}
export type SessionStopResult = { ok: true }

// ---- Push event payloads ----

export interface SandboxStatusPayload {
  enforced: boolean
  mechanism: string
  warnings: string[]
}

export interface PlanUpdatedPayload {
  steps: PlanStep[]
}

export interface AssistantDeltaPayload {
  text: string
}

export interface ToolCallPayload {
  callId: string
  tool: string
  args: unknown
}

export interface ToolResultPayload {
  callId: string
  tool: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface StepStatusPayload {
  index: number
  status: PlanStepStatus
}

export interface FailedPayload {
  message: string
}

/** Maps each push-event name to its payload type, for a typed subscriber. */
export interface PushEventPayloads {
  'session.sandboxStatus': SandboxStatusPayload
  'session.planUpdated': PlanUpdatedPayload
  'session.assistantDelta': AssistantDeltaPayload
  'session.toolCall': ToolCallPayload
  'session.toolResult': ToolResultPayload
  'session.stepStatus': StepStatusPayload
  'session.completed': Record<string, never>
  'session.failed': FailedPayload
}

export type PushEventName = keyof PushEventPayloads
