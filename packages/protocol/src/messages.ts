// Payload shapes for RPC methods and push events.
// Shapes mirroring vajra-core types are hand-duplicated — this package
// must stay loadable in a browser bundle.

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

export type SessionStatus = 'starting' | 'talking' | 'confirming' | 'planning' | 'executing' | 'running' | 'done' | 'failed' | 'stopped'

export type AgentRole = 'developer' | 'master' | 'worker'
export type AgentStatus = 'pending' | 'running' | 'done' | 'failed'
export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'skipped'
export type TaskType = 'create' | 'modify' | 'delete' | 'refactor'

export interface PlannedTask {
  id: string
  title: string
  description: string
  /** Step-by-step instructions for the worker — exactly what to do. */
  instructions: string[]
  /** Files this task reads (read-only access). */
  readFile: string[]
  /** Files this task writes/edits (read-write access). */
  writeFile: string[]
  /** Files this task deletes. */
  deleteFile: string[]
  /** Directories this task creates. */
  createDir: string[]
  /** Commands to run for validation (e.g. ["cargo test", "npm run lint"]). */
  validation: string[]
  /** Task IDs this depends on (must complete before this runs). */
  dependsOn: string[]
  /** Task type: create, modify, delete, or refactor. */
  type: TaskType
  /** Tools this worker can use. If omitted, defaults to task-type defaults. */
  allowedTools?: string[]
  /** Timeout in seconds for this task. Default: 120. */
  timeout?: number
  /** Max retries for this task. Default: 2. Set to 0 for no retries. */
  retries?: number
  /** Rollback instructions if validation fails (e.g. "git checkout src/file.ts"). */
  rollback?: string[]
  /** Condition to skip this task (e.g. "file exists: src/config.json" or "command passes: npm test"). */
  skipIf?: string[]
  /** Task complexity: low, medium, or high. Affects task sizing and ordering. */
  complexity?: 'low' | 'medium' | 'high'
  /** Validation strategy: hierarchical, incremental, or contextAware. */
  validationStrategy?: 'hierarchical' | 'incremental' | 'contextAware'
  /** Alternative approaches to solve this task. */
  alternativeApproaches?: string[]
  /** Estimated duration in minutes. */
  estimatedDuration?: number
}

export interface DeveloperPlan {
  tasks: PlannedTask[]
  independentGroups: string[][]
  estimatedWorkers: number
}

export interface AgentStatePayload {
  id: string
  role: AgentRole
  status: AgentStatus
  taskSummary: string | null
}

export interface TaskStatePayload {
  id: string
  title: string
  status: TaskStatus
  assignedAgentId: string | null
  validationPassed: boolean | null
}

export interface ConflictPayload {
  task1: string
  task2: string
  files: string[]
}

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
  /** Must originate from an explicit user confirmation in the UI. */
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

export interface SessionConfirmPlanParams {
  sessionId: string
  /** User-edited task list. When absent, the originally proposed plan is used. */
  tasks?: PlannedTask[]
}
export type SessionConfirmPlanResult = { ok: true }

export interface SessionRejectPlanParams {
  sessionId: string
}
export type SessionRejectPlanResult = { ok: true }

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

export interface PushEventPayloads {
  'session.statusChanged': { status: SessionStatus }
  'session.sandboxStatus': SandboxStatusPayload
  'session.assistantDelta': AssistantDeltaPayload
  'session.thinkingDelta': ThinkingDeltaPayload
  'session.completed': Record<string, never>
  'session.failed': FailedPayload
  'session.deleted': { sessionId: string }
  'session.planStarted': { sessionId: string }
  'session.planTask': { sessionId: string; task: PlannedTask }
  'session.planComplete': { sessionId: string; plan: DeveloperPlan }
  'session.planProposed': { sessionId: string; plan: DeveloperPlan }
  'session.planConfirmed': Record<string, never>
  'session.workerStarted': { sessionId: string; agentId: string; taskId: string }
  'session.workerProgress': { sessionId: string; agentId: string; task: string; detail: string }
  'session.workerCompleted': { sessionId: string; agentId: string; taskId: string; validationPassed: boolean }
  'session.workerFailed': { sessionId: string; agentId: string; taskId: string; error: string }
  'session.conflictDetected': { sessionId: string } & ConflictPayload
  'session.conflictResolved': { sessionId: string; task1: string; task2: string; resolution: string }
}

export type PushEventName = keyof PushEventPayloads
