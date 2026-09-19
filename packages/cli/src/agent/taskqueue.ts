import type { PlannedTask as ProtocolPlannedTask } from '@codekalakaars/vajra-protocol'

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'skipped'

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
  private fileToTask = new Map<string, string>()

  constructor(private sessionId: string) {}

  addTask(task: ProtocolPlannedTask, filePermissions?: string, toolPermissions?: string): TaskState {
    const now = Date.now()

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

    const allFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
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
      const allDepsComplete = [...deps].every(depId => {
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
  }

  startTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = 'running'
    task.startedAt = Date.now()
  }

  completeTask(taskId: string, validationPassed?: boolean): TaskState[] {
    const task = this.tasks.get(taskId)
    if (!task) return []
    task.status = 'done'
    task.completedAt = Date.now()
    task.validationPassed = validationPassed ?? null

    for (const [file, ownerTaskId] of this.fileToTask) {
      if (ownerTaskId === taskId) {
        this.fileToTask.delete(file)
      }
    }

    return this.getReadyTasks()
  }

  failTask(taskId: string): TaskState[] {
    const task = this.tasks.get(taskId)
    if (!task) return []
    task.status = 'failed'
    task.completedAt = Date.now()

    for (const [file, ownerTaskId] of this.fileToTask) {
      if (ownerTaskId === taskId) {
        this.fileToTask.delete(file)
      }
    }

    this.skipDependents(taskId)

    return this.getReadyTasks()
  }

  private skipDependents(taskId: string): void {
    const queue = [taskId]
    while (queue.length > 0) {
      const currentId = queue.shift()!
      for (const [id, task] of this.tasks) {
        if (task.status !== 'pending') continue
        if (task.dependsOn.includes(currentId)) {
          task.status = 'skipped'
          task.completedAt = Date.now()
          queue.push(id)
        }
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
  }

  skipTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = 'skipped'
    task.completedAt = Date.now()
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
  }

  getStatus(): QueueStatus {
    const counts: QueueStatus = { total: 0, pending: 0, assigned: 0, running: 0, done: 0, failed: 0, skipped: 0, ready: 0 }
    for (const task of this.tasks.values()) {
      counts.total++
      counts[task.status]++
    }
    counts.ready = this.getReadyTasks().length
    return counts
  }

  recordValidation(taskId: string, output: string, passed: boolean): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.validationPassed = passed
    }
  }

  getAllTasks(): TaskState[] {
    return [...this.tasks.values()]
  }
}
