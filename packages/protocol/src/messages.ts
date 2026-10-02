// The shapes shared between the Developer, the Manager and the Workers: file
// permissions, the plan and its tasks. Pure types, so the package has no
// runtime dependencies.

import type { ContextRef, EditSpec, PlanContract, VerifySpec } from './tools.js'

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

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'skipped'
export type TaskType = 'create' | 'modify' | 'delete' | 'refactor'

export interface PlannedTask {
  id: string
  title: string
  description: string
  /** Structured planning fields (docs/TASK_SPEC.md). When present they are the
   *  source of truth and the flat arrays below are lowered from them. */
  context?: ContextRef[]
  edits?: EditSpec[]
  verify?: VerifySpec[]
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
  /** What "done" means, in words the Worker can check against. */
  successCriteria?: string[]
  /** Short notes no file shows: a gotcha, an approach to avoid. */
  notes?: string
  /** Task type: create, modify, delete, or refactor. */
  type: TaskType
  /** Tools this worker can use. If omitted, defaults to task-type defaults. */
  allowedTools?: string[]
  /** Timeout in seconds for this task. Default: 120. */
  timeoutSeconds?: number
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
  /** Decisions tasks must agree on; each reaches the tasks it names. */
  contracts?: PlanContract[]
}
