import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'

export interface FileChange {
  taskId: string
  filePath: string
  originalContent: string | null
  timestamp: number
}

export interface TaskChanges {
  taskId: string
  files: Map<string, string | null> // filePath -> originalContent (null = file was created)
  timestamp: number
}

/**
 * Tracks file modifications for rollback support.
 * Stores original file content before each modification,
 * allowing rollback to the pre-modification state.
 *
 * If projectDir is provided, all paths are resolved relative to it
 * and a guard refuses any resolved path outside the project root.
 */
export class ChangeHistory {
  private changes = new Map<string, TaskChanges>()
  private projectDir: string | null

  constructor(projectDir?: string) {
    this.projectDir = projectDir ?? null
  }

  /**
   * Resolve a task-relative path to an absolute path, ensuring it stays
   * within the project directory. If no projectDir was set, returns the
   * path as-is (legacy behavior).
   */
  private resolvePath(filePath: string): string {
    if (!this.projectDir) return filePath
    const abs = resolve(this.projectDir, filePath)
    // Guard: resolved path must be inside the project root
    const rel = relative(this.projectDir, abs)
    if (rel.startsWith('..')) {
      throw new Error(`Path '${filePath}' resolves outside project directory`)
    }
    return abs
  }

  /**
   * Record that a file is about to be modified.
   * Stores the original content so we can rollback later.
   */
  async recordBefore(taskId: string, filePath: string): Promise<void> {
    let taskChanges = this.changes.get(taskId)
    if (!taskChanges) {
      taskChanges = { taskId, files: new Map(), timestamp: Date.now() }
      this.changes.set(taskId, taskChanges)
    }

    // Don't overwrite if we already recorded this file
    if (taskChanges.files.has(filePath)) return

    const resolvedPath = this.resolvePath(filePath)

    try {
      const content = await readFile(resolvedPath, 'utf-8')
      taskChanges.files.set(filePath, content)
    } catch {
      // File doesn't exist yet — record as null (will be deleted on rollback)
      taskChanges.files.set(filePath, null)
    }
  }

  /**
   * Record that a file was created (not modified).
   * Used for new files — on rollback, the file will be deleted.
   */
  recordCreated(taskId: string, filePath: string): void {
    let taskChanges = this.changes.get(taskId)
    if (!taskChanges) {
      taskChanges = { taskId, files: new Map(), timestamp: Date.now() }
      this.changes.set(taskId, taskChanges)
    }

    // Only record if not already tracked
    if (!taskChanges.files.has(filePath)) {
      taskChanges.files.set(filePath, null) // null = file was created
    }
  }

  /**
   * Rollback all changes made by a task.
   * Restores original file content or deletes created files.
   */
  async rollback(taskId: string): Promise<{ restored: string[]; deleted: string[] }> {
    const taskChanges = this.changes.get(taskId)
    if (!taskChanges) return { restored: [], deleted: [] }

    const restored: string[] = []
    const deleted: string[] = []

    for (const [filePath, originalContent] of taskChanges.files) {
      const resolvedPath = this.resolvePath(filePath)
      try {
        if (originalContent === null) {
          // File was created — delete it
          const { unlink } = await import('node:fs/promises')
          await unlink(resolvedPath)
          deleted.push(filePath)
        } else {
          // File was modified — restore original content
          // Ensure parent directory exists
          await mkdir(dirname(resolvedPath), { recursive: true })
          await writeFile(resolvedPath, originalContent, 'utf-8')
          restored.push(filePath)
        }
      } catch {
        // Best effort — file might not exist or might be read-only
      }
    }

    // Clean up tracking
    this.changes.delete(taskId)

    return { restored, deleted }
  }

  /**
   * Get all files modified by a task.
   */
  getTaskFiles(taskId: string): string[] {
    const taskChanges = this.changes.get(taskId)
    return taskChanges ? Array.from(taskChanges.files.keys()) : []
  }

  /**
   * Get the original content of a file before modification.
   */
  getOriginalContent(taskId: string, filePath: string): string | null | undefined {
    const taskChanges = this.changes.get(taskId)
    return taskChanges?.files.get(filePath)
  }

  /**
   * Check if a task has any recorded changes.
   */
  hasChanges(taskId: string): boolean {
    const taskChanges = this.changes.get(taskId)
    return taskChanges ? taskChanges.files.size > 0 : false
  }

  /**
   * Get all tasks that have recorded changes.
   */
  getActiveTaskIds(): string[] {
    return Array.from(this.changes.keys())
  }

  /**
   * Clear all recorded changes (e.g., on session end).
   */
  clear(): void {
    this.changes.clear()
  }

  /**
   * Get a summary of all changes for debugging.
   */
  getSummary(): { taskId: string; files: string[] }[] {
    return Array.from(this.changes.values()).map(tc => ({
      taskId: tc.taskId,
      files: Array.from(tc.files.keys()),
    }))
  }
}
