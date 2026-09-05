import { randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db/client.js'

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'skipped'

export interface PlannedTask {
  id: string
  title: string
  description: string
  files: string[]
  validation: string
  dependsOn: string[]
  type: 'create' | 'modify' | 'delete' | 'refactor'
}

export interface TaskState {
  id: string
  sessionId: string
  parentTaskId: string | null
  title: string
  description: string | null
  files: string[]
  validation: string
  dependsOn: string[]
  type: 'create' | 'modify' | 'delete' | 'refactor'
  status: TaskStatus
  assignedAgentId: string | null
  validationCommand: string | null
  validationOutput: string | null
  validationPassed: boolean | null
  filePermissions: string | null
  toolPermissions: string | null
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
        `INSERT INTO tasks (id, session_id, title, description, status, validation_command, file_permissions, tool_permissions, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        this.sessionId,
        task.title,
        task.description,
        task.validation || null,
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

    const state: TaskState = {
      id: task.id,
      sessionId: this.sessionId,
      parentTaskId: null,
      title: task.title,
      description: task.description,
      files: task.files,
      validation: task.validation,
      dependsOn: task.dependsOn,
      type: task.type,
      status: 'pending',
      assignedAgentId: null,
      validationCommand: task.validation || null,
      validationOutput: null,
      validationPassed: null,
      filePermissions: filePermissions ?? null,
      toolPermissions: toolPermissions ?? null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    }

    this.tasks.set(task.id, state)
    this.dependencies.set(task.id, new Set(task.dependsOn))

    // Register file ownership
    for (const file of task.files) {
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

    // Check if any file is owned by both tasks
    for (const [file, owner] of this.fileToTask) {
      if (owner === task1Id || owner === task2Id) {
        // Check if the other task also references this file
        const task1Files = this.getTaskFiles(task1Id)
        const task2Files = this.getTaskFiles(task2Id)
        if (task1Files.includes(file) && task2Files.includes(file)) {
          return true
        }
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
      task.validationOutput = output
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
