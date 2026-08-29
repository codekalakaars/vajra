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

export type SessionStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped'

// ---- RPC method params/results ----

export interface ProjectLoadPermissionsParams {
  projectDir: string
}
export type ProjectLoadPermissionsResult = PermissionsConfig

export interface ProjectSavePermissionsParams {
  projectDir: string
  config: PermissionsConfig
}
export type ProjectSavePermissionsResult = { ok: true }

export interface ProjectScanParams {
  projectDir: string
}
export type ProjectScanResult = ProjectFileEntry[]

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
  model: string
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
  sandbox: SandboxStatusPayload | null
  messages: AttachMessage[]
}

export interface SessionStopParams {
  sessionId: string
}
export type SessionStopResult = { ok: true }

export interface SessionDeleteParams {
  sessionId: string
}
export type SessionDeleteResult = { ok: true }

export interface SessionSendMessageParams {
  sessionId: string
  content: string
}
export type SessionSendMessageResult = { ok: true }

// ---- Push event payloads ----

export interface SandboxStatusPayload {
  enforced: boolean
  mechanism: string
  warnings: string[]
}

export interface AssistantDeltaPayload {
  text: string
}

export interface FailedPayload {
  message: string
}

export interface ThinkingDeltaPayload {
  text: string
}

/** Maps each push-event name to its payload type, for a typed subscriber. */
export interface PushEventPayloads {
  'session.sandboxStatus': SandboxStatusPayload
  'session.assistantDelta': AssistantDeltaPayload
  'session.thinkingDelta': ThinkingDeltaPayload
  'session.completed': Record<string, never>
  'session.failed': FailedPayload
  'session.deleted': { sessionId: string }
}

export type PushEventName = keyof PushEventPayloads
