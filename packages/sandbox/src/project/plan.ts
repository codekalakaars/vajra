// Task, queue and agent state shapes shared between CLI and server.
//
// Types only. The planning algorithms that used to live here moved to
// @codekalakaars/vajra-protocol (plan-validate.ts), which is the module the
// Developer validates against; the two copies disagreed, and the live one was
// this package's.

import type { PlannedTask } from '@codekalakaars/vajra-protocol'

/**
 * Task status and queue types used by both CLI and server.
 */
export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'skipped'

export interface TaskState {
  id: string
  projectId: string
  title: string
  description: string | null
  instructions: string[]
  readFile: string[]
  writeFile: string[]
  deleteFile: string[]
  createDir: string[]
  validation: string[]
  dependsOn: string[]
  type: 'create' | 'modify' | 'delete' | 'refactor'
  status: TaskStatus
  assignedAgentId: string | null
  validationPassed: boolean | null
  filePermissions: string | null
  toolPermissions: string | null
  retries: number
  maxRetries: number
  timeout: number
  rollback: string[]
  skipIf: string[]
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface QueueStatus {
  total: number
  pending: number
  assigned: number
  running: number
  done: number
  failed: number
  skipped: number
  ready: number
}

export type AgentRole = 'developer' | 'master' | 'worker'
export type AgentStatus = 'pending' | 'running' | 'done' | 'failed'

export interface AgentState {
  id: string
  projectId: string
  role: AgentRole
  status: AgentStatus
  taskSummary: string | null
  parentAgentId: string | null
  createdAt: number
  endedAt: number | null
}
