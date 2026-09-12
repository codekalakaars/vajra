import { randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db/client.js'

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'skipped'

export interface PlannedTask {
  id: string
  title: string
  description: string
  instructions: string[]
  readFile: string[]
  writeFile: string[]
  deleteFile: string[]
  createDir: string[]
  validation: string[]
  dependsOn: string[]
  type: 'create' | 'modify' | 'delete' | 'refactor'
  allowedTools?: string[]
  timeout?: number
  maxRetries?: number
  rollback?: string[]
  skipIf?: string[]
}

export interface TaskState {
  id: string
  sessionId: string
  parentTaskId: string | null
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

export class TaskQueue {
  private tasks = new Map<string, TaskState>()
  private dependencies = new Map<string, Set<string>>()
  private fileToTask = new Map<string, string>() // file -> task ID that owns it

  constructor(
    private db: SqliteDb,
    private sessionId: string,
  ) {}

  addTask(task: PlannedTask, filePermissions?: string, toolPermissions?: string): TaskState {
    const now = Date.now()

    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, title, description, status, file_permissions, tool_permissions, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        task.id,
        this.sessionId,
        task.title,
        task.description,
        filePermissions ?? null,
        toolPermissions ?? null,
        now,
      )

    // Store dependencies
    for (const depId of task.dependsOn) {
      this.db
        .prepare(`INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)`)
        .run(task.id, depId)
    }

    // All files this task touches (for file ownership tracking)
    const allFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]

    const state: TaskState = {
      id: task.id,
      sessionId: this.sessionId,
      parentTaskId: null,
      title: task.title,
      description: task.description,
      instructions: task.instructions,
      readFile: task.readFile,
      writeFile: task.writeFile,
      deleteFile: task.deleteFile,
      createDir: task.createDir,
      validation: task.validation,
      dependsOn: task.dependsOn,
      type: task.type,
      status: 'pending',
      assignedAgentId: null,
      filePermissions: filePermissions ?? null,
      toolPermissions: toolPermissions ?? null,
      retries: 0,
      maxRetries: task.maxRetries ?? 2,
      timeout: task.timeout ?? 120,
      rollback: task.rollback ?? [],
      skipIf: task.skipIf ?? [],
      validationPassed: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    }

    this.tasks.set(task.id, state)
    this.dependencies.set(task.id, new Set(task.dependsOn))

    // Register file ownership
    for (const file of allFiles) {
      this.fileToTask.set(file, task.id)
    }

    return state
  }

  getReadyTasks(): TaskState[] {
    const ready: TaskState[] = []

    for (const [id, task] of this.tasks) {
      if (task.status !== 'pending') continue

      const deps = this.dependencies.get(id) ?? new Set()
      const allDepsComplete = [...deps].every((depId) => {
        const dep = this.tasks.get(depId)
        return dep?.status === 'done' || dep?.status === 'skipped'
      })

      if (allDepsComplete) {
        ready.push(task)
      }
    }

    return ready
  }

  assignTask(taskId: string, agentId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'assigned'
    task.assignedAgentId = agentId

    this.db
      .prepare(`UPDATE tasks SET status = 'assigned', assigned_agent_id = ? WHERE id = ?`)
      .run(agentId, taskId)
  }

  startTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'running'
    task.startedAt = Date.now()

    this.db
      .prepare(`UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`)
      .run(task.startedAt, taskId)
  }

  completeTask(taskId: string, validationPassed?: boolean): TaskState[] {
    const task = this.tasks.get(taskId)
    if (!task) return []

    task.status = 'done'
    task.completedAt = Date.now()
    task.validationPassed = validationPassed ?? null

    this.db
      .prepare(
        `UPDATE tasks SET status = 'done', completed_at = ?, validation_passed = ? WHERE id = ?`,
      )
      .run(task.completedAt, validationPassed === true ? 1 : validationPassed === false ? 0 : null, taskId)

    // Release file ownership
    for (const [file, ownerTaskId] of this.fileToTask) {
      if (ownerTaskId === taskId) {
        this.fileToTask.delete(file)
      }
    }

    // Return newly ready tasks
    return this.getReadyTasks()
  }

  failTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'failed'
    task.completedAt = Date.now()

    this.db
      .prepare(`UPDATE tasks SET status = 'failed', completed_at = ? WHERE id = ?`)
      .run(task.completedAt, taskId)

    // Release file ownership
    for (const [file, ownerTaskId] of this.fileToTask) {
      if (ownerTaskId === taskId) {
        this.fileToTask.delete(file)
      }
    }
  }

  retryTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.retries++
    task.status = 'pending'
    task.assignedAgentId = null
    task.startedAt = null

    this.db
      .prepare(`UPDATE tasks SET status = 'pending', assigned_agent_id = NULL, started_at = NULL WHERE id = ?`)
      .run(taskId)
  }

  skipTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'skipped'
    task.completedAt = Date.now()

    this.db
      .prepare(`UPDATE tasks SET status = 'skipped', completed_at = ? WHERE id = ?`)
      .run(task.completedAt, taskId)
  }

  /**
   * Check if two tasks conflict (share files that at least one writes).
   */
  hasConflict(task1Id: string, task2Id: string): boolean {
    const task1 = this.tasks.get(task1Id)
    const task2 = this.tasks.get(task2Id)
    if (!task1 || !task2) return false

    // Get files each task writes to (writeFile + deleteFile)
    const task1WriteFiles = [...task1.writeFile, ...task1.deleteFile]
    const task2WriteFiles = [...task2.writeFile, ...task2.deleteFile]

    // Check if task1 writes to any file task2 reads or writes
    for (const file of task1WriteFiles) {
      if (task2.readFile.includes(file) || task2WriteFiles.includes(file)) {
        return true
      }
    }

    // Check if task2 writes to any file task1 reads
    for (const file of task2WriteFiles) {
      if (task1.readFile.includes(file)) {
        return true
      }
    }

    return false
  }

  /**
   * Get files owned by a currently running task.
   */
  getLockedFiles(): Set<string> {
    const locked = new Set<string>()
    for (const [file, taskId] of this.fileToTask) {
      const task = this.tasks.get(taskId)
      if (task?.status === 'running' || task?.status === 'assigned') {
        locked.add(file)
      }
    }
    return locked
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
  }

  getTaskFiles(taskId: string): string[] {
    const files: string[] = []
    for (const [file, owner] of this.fileToTask) {
      if (owner === taskId) files.push(file)
    }
    return files
  }

  /**
   * Check if a set of tasks can all run in parallel (no write conflicts between any pair).
   */
  canRunInParallel(taskIds: string[]): boolean {
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 1; j < taskIds.length; j++) {
        if (this.hasConflict(taskIds[i], taskIds[j])) {
          return false
        }
      }
    }
    return true
  }

  /**
   * Group ready tasks into parallel batches (each batch has no internal conflicts).
   */
  getParallelBatches(): string[][] {
    const ready = this.getReadyTasks()
    const batches: string[][] = []
    const assigned = new Set<string>()

    for (const task of ready) {
      if (assigned.has(task.id)) continue

      const batch = [task.id]
      assigned.add(task.id)

      for (const other of ready) {
        if (assigned.has(other.id)) continue
        if (this.canRunInParallel([...batch, other.id])) {
          batch.push(other.id)
          assigned.add(other.id)
        }
      }

      batches.push(batch)
    }

    return batches
  }

  getStatus(): QueueStatus {
    const counts = { total: 0, pending: 0, assigned: 0, running: 0, done: 0, failed: 0, skipped: 0, ready: 0 }
    for (const task of this.tasks.values()) {
      counts.total++
      counts[task.status]++
    }
    counts.ready = this.getReadyTasks().length
    return counts
  }

  /**
   * Persist validation output for a task.
   */
  recordValidation(taskId: string, output: string, passed: boolean): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.validationPassed = passed
    }

    this.db
      .prepare(`UPDATE tasks SET validation_output = ?, validation_passed = ? WHERE id = ?`)
      .run(output, passed ? 1 : 0, taskId)
  }

  /**
   * Get all tasks for a session.
   */
  getAllTasks(): TaskState[] {
    return [...this.tasks.values()]
  }
}
