import type { SqliteDb } from '../db/client.js'
import { stmt } from '../db/statements.js'
import type { PlannedTask } from '@codekalakaars/vajra-protocol'

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'skipped'

export interface TaskState {
  id: string
  projectId: string
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

  constructor(
    private db: SqliteDb,
    private projectId: string,
  ) {}

  addTask(task: PlannedTask, filePermissions?: string, toolPermissions?: string): TaskState {
    const now = Date.now()

    stmt(
      this.db,
      `INSERT INTO tasks (id, session_id, title, description, status, file_permissions, tool_permissions, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
        task.id,
        this.projectId,
        task.title,
        task.description,
        filePermissions ?? null,
        toolPermissions ?? null,
        now,
      )

    // Store dependencies
    for (const depId of task.dependsOn) {
      stmt(this.db, `INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)`).run(task.id, depId)
    }

    const state: TaskState = {
      id: task.id,
      projectId: this.projectId,
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
      maxRetries: task.retries ?? 2,
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

    stmt(this.db, `UPDATE tasks SET status = 'assigned', assigned_agent_id = ? WHERE id = ?`).run(agentId, taskId)
  }

  startTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'running'
    task.startedAt = Date.now()

    stmt(this.db, `UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`).run(task.startedAt, taskId)
  }

  completeTask(taskId: string, validationPassed?: boolean): TaskState[] {
    const task = this.tasks.get(taskId)
    if (!task) return []

    task.status = 'done'
    task.completedAt = Date.now()
    task.validationPassed = validationPassed ?? null

    stmt(this.db, `UPDATE tasks SET status = 'done', completed_at = ?, validation_passed = ? WHERE id = ?`)
      .run(task.completedAt, validationPassed === true ? 1 : validationPassed === false ? 0 : null, taskId)

    // Return newly ready tasks
    return this.getReadyTasks()
  }

  failTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'failed'
    task.completedAt = Date.now()

    stmt(this.db, `UPDATE tasks SET status = 'failed', completed_at = ? WHERE id = ?`).run(task.completedAt, taskId)
  }

  retryTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.retries++
    task.status = 'pending'
    task.assignedAgentId = null
    task.startedAt = null

    stmt(this.db, `UPDATE tasks SET status = 'pending', assigned_agent_id = NULL, started_at = NULL WHERE id = ?`).run(taskId)
  }

  skipTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'skipped'
    task.completedAt = Date.now()

    stmt(this.db, `UPDATE tasks SET status = 'skipped', completed_at = ? WHERE id = ?`).run(task.completedAt, taskId)
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
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
   * Persist validation output for a task. Appends on retry so the worker can
   * see why it failed last time.
   */
  recordValidation(taskId: string, output: string, passed: boolean): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.validationPassed = passed
    }

    // Append rather than overwrite so retry history is preserved
    const existing = this.db
      .prepare(`SELECT validation_output FROM tasks WHERE id = ?`)
      .get(taskId) as { validation_output?: string } | undefined
    const combined = existing?.validation_output
      ? `${existing.validation_output}\n---\n${output}`
      : output

    stmt(this.db, `UPDATE tasks SET validation_output = ?, validation_passed = ? WHERE id = ?`).run(combined, passed ? 1 : 0, taskId)
  }

  /**
   * Get all tasks for a project.
   */
  getAllTasks(): TaskState[] {
    return [...this.tasks.values()]
  }
}
