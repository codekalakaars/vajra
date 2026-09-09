// Read-shared/write-exclusive file locking for parallel task execution.
//
// Multiple tasks can read the same file concurrently, but writes are
// exclusive — no other readers or writers while a write lock is held.
// Locks are per-task, released when a task completes or fails.

export type LockMode = 'read' | 'write'

export interface Lock {
  owner: string
  mode: LockMode
  acquiredAt: number
}

type Waiter = () => void

/**
 * Manages file-level locks for parallel task execution.
 *
 * Usage:
 *   const locks = new FileLockManager()
 *   if (locks.canAcquire(files, 'write')) {
 *     locks.acquire(files, taskId, 'write')
 *     // ... do work ...
 *     locks.release(taskId)
 *   }
 */
export class FileLockManager {
  /** file path → array of active locks */
  private locks = new Map<string, Lock[]>()

  /** queue of pending acquire requests, notified on release */
  private waiters: Waiter[] = []

  /**
   * Check if acquiring locks on files would succeed without blocking.
   *
   * For 'read': returns false only if a 'write' lock exists on any file.
   * For 'write': returns false if ANY lock (read or write) exists on any file.
   */
  canAcquire(files: string[], mode: LockMode): boolean {
    for (const file of files) {
      const fileLocks = this.locks.get(file)
      if (!fileLocks || fileLocks.length === 0) continue

      if (mode === 'write') {
        // Write requires no existing locks (read or write)
        return false
      }

      // Read blocks only if a write lock exists
      const hasWrite = fileLocks.some((l) => l.mode === 'write')
      if (hasWrite) return false
    }
    return true
  }

  /**
   * Acquire locks on files. Returns true if acquired immediately,
   * false if the caller should wait (use `waitForRelease` after calling).
   *
   * This is non-blocking — it attempts acquisition and returns the result.
   * Use `acquireOrWait` for a blocking acquire.
   */
  tryAcquire(files: string[], owner: string, mode: LockMode): boolean {
    if (!this.canAcquire(files, mode)) return false

    const now = Date.now()
    for (const file of files) {
      const fileLocks = this.locks.get(file) ?? []
      fileLocks.push({ owner, mode, acquiredAt: now })
      this.locks.set(file, fileLocks)
    }
    return true
  }

  /**
   * Wait for locks to become available, then acquire them.
   * Returns when the locks are acquired.
   */
  async acquireOrWait(files: string[], owner: string, mode: LockMode): Promise<void> {
    while (!this.tryAcquire(files, owner, mode)) {
      await this.waitForRelease()
    }
  }

  /**
   * Release all locks held by an owner.
   */
  release(owner: string): void {
    for (const [file, fileLocks] of this.locks) {
      const remaining = fileLocks.filter((l) => l.owner !== owner)
      if (remaining.length === 0) {
        this.locks.delete(file)
      } else {
        this.locks.set(file, remaining)
      }
    }
    this.notifyWaiters()
  }

  /**
   * Release specific files held by an owner.
   */
  releaseFiles(files: string[], owner: string): void {
    for (const file of files) {
      const fileLocks = this.locks.get(file)
      if (!fileLocks) continue

      const remaining = fileLocks.filter((l) => l.owner !== owner)
      if (remaining.length === 0) {
        this.locks.delete(file)
      } else {
        this.locks.set(file, remaining)
      }
    }
    this.notifyWaiters()
  }

  /**
   * Get all locks currently held. Useful for debugging.
   */
  getLocks(): Map<string, Lock[]> {
    return new Map(this.locks)
  }

  /**
   * Get all owners holding locks on a file.
   */
  getOwners(file: string): string[] {
    const fileLocks = this.locks.get(file)
    if (!fileLocks) return []
    return [...new Set(fileLocks.map((l) => l.owner))]
  }

  /**
   * Check if an owner holds any locks.
   */
  hasLocks(owner: string): boolean {
    for (const fileLocks of this.locks.values()) {
      if (fileLocks.some((l) => l.owner === owner)) return true
    }
    return false
  }

  /**
   * Wait for any lock to be released. Resolves on the next release event.
   */
  waitForRelease(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /**
   * Drain all locks and reject pending waiters.
   * Called when a session is stopped.
   */
  drain(): void {
    this.locks.clear()
    // Reject all waiters by resolving them (they'll fail on next tryAcquire)
    const waiters = this.waiters.splice(0)
    for (const w of waiters) w()
  }

  private notifyWaiters(): void {
    const waiters = this.waiters.splice(0)
    for (const w of waiters) w()
  }
}
