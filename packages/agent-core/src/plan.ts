// Plan-related types and algorithms shared between CLI and server.
//
// These are pure functions that operate on PlannedTask arrays.

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

/**
 * Detect and remove circular dependencies with depth-first search.
 * Only the edge that closes a cycle is dropped.
 */
export function detectAndRemoveCircularDeps(tasks: PlannedTask[]): PlannedTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const visited = new Set<string>()
  const onStack = new Set<string>()
  const removed: string[] = []

  function visit(taskId: string): void {
    if (visited.has(taskId)) return
    visited.add(taskId)
    onStack.add(taskId)

    const task = taskMap.get(taskId)
    if (task) {
      const kept: string[] = []
      for (const dep of task.dependsOn) {
        if (onStack.has(dep)) {
          removed.push(`${taskId} -> ${dep}`)
          continue
        }
        visit(dep)
        kept.push(dep)
      }
      task.dependsOn = kept
    }

    onStack.delete(taskId)
  }

  for (const task of tasks) {
    visit(task.id)
  }

  return tasks
}

/**
 * Add file-level dependencies based on file access patterns.
 * If task A writes to a file that task B reads, B depends on A.
 */
export function addFileLevelDependencies(tasks: PlannedTask[]): PlannedTask[] {
  const planOrder = new Map(tasks.map((t, i) => [t.id, i]))

  for (const task of tasks) {
    for (const other of tasks) {
      if (task.id === other.id) continue
      if (task.dependsOn.includes(other.id)) continue

      const producesInput = other.writeFile.some(file => task.readFile.includes(file))
      const sharesOutput =
        other.writeFile.some(file => task.writeFile.includes(file)) &&
        (planOrder.get(other.id) ?? 0) < (planOrder.get(task.id) ?? 0)

      if (producesInput || sharesOutput) {
        task.dependsOn.push(other.id)
      }
    }
  }

  return tasks
}

/**
 * Compute parallel execution waves.
 * Level 0 = tasks with no dependencies; level N = tasks whose deps are all in earlier levels.
 */
export function computeWaves(tasks: PlannedTask[]): string[][] {
  const waves: string[][] = []
  const placed = new Set<string>()

  while (placed.size < tasks.length) {
    const wave = tasks
      .filter(t => !placed.has(t.id) && t.dependsOn.every(dep => placed.has(dep)))
      .map(t => t.id)

    if (wave.length === 0) {
      // Remaining tasks form a cycle — emit them as a final wave
      waves.push(tasks.filter(t => !placed.has(t.id)).map(t => t.id))
      break
    }

    for (const id of wave) placed.add(id)
    waves.push(wave)
  }

  return waves
}

/**
 * Optimize task order within groups for better parallelism (low complexity first).
 */
export function optimizeTaskOrder(tasks: PlannedTask[], independentGroups: string[][]): PlannedTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const optimized: PlannedTask[] = []
  const complexityOrder = { low: 0, medium: 1, high: 2 }

  for (const group of independentGroups) {
    const groupTasks = group
      .map(id => taskMap.get(id)!)
      .sort((a, b) =>
        (complexityOrder[a.complexity ?? 'medium'] ?? 1) -
        (complexityOrder[b.complexity ?? 'medium'] ?? 1)
      )
    optimized.push(...groupTasks)
  }

  return optimized
}

/**
 * Pure getReadyTasks: given a task map and dependency map, return tasks whose
 * dependencies are all done or skipped.
 */
export function computeReadyTasks(
  tasks: Map<string, TaskState>,
  dependencies: Map<string, Set<string>>,
): TaskState[] {
  const ready: TaskState[] = []

  for (const [id, task] of tasks) {
    if (task.status !== 'pending') continue

    const deps = dependencies.get(id) ?? new Set()
    const allDepsComplete = [...deps].every(depId => {
      const dep = tasks.get(depId)
      return dep?.status === 'done' || dep?.status === 'skipped'
    })

    if (allDepsComplete) {
      ready.push(task)
    }
  }

  return ready
}
