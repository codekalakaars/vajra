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
 * Uses a reverse index (owner → files) for O(k) release where k is the
 * number of files the owner holds, and per-file wait queues to avoid
 * thundering-herd wake-ups.
 *
 * Usage:
 *   const locks = new FileLockManager()
 *   if (locks.canAcquire(files, 'write')) {
 *     locks.tryAcquire(files, taskId, 'write')
 *     // ... do work ...
 *     locks.release(taskId)
 *   }
 */
export class FileLockManager {
  /** file path → array of active locks */
  private locks = new Map<string, Lock[]>()

  /** owner → set of files they hold locks on (reverse index) */
  private ownerFiles = new Map<string, Set<string>>()

  /** file path → queue of pending acquire requests */
  private waiters = new Map<string, Waiter[]>()

  /**
   * Check if acquiring locks on files would succeed without blocking.
   *
   * For 'read': returns false only if a 'write' lock exists on any file
   *   (held by a *different* owner — same-owner locks are re-entrant).
   * For 'write': returns false if ANY lock (read or write) from a
   *   *different* owner exists on any file. Same-owner read locks can be
   *   upgraded to write.
   */
  canAcquire(files: string[], mode: LockMode, owner?: string): boolean {
    for (const file of files) {
      const fileLocks = this.locks.get(file)
      if (!fileLocks || fileLocks.length === 0) continue

      if (mode === 'write') {
        // Write requires no locks from *other* owners. Same-owner locks
        // are fine (allows upgrading read → write).
        const hasOtherOwner = fileLocks.some((l) => l.owner !== owner)
        if (hasOtherOwner) return false
      } else {
        // Read blocks only if a write lock exists from a different owner
        const hasOtherWrite = fileLocks.some((l) => l.mode === 'write' && l.owner !== owner)
        if (hasOtherWrite) return false
      }
    }
    return true
  }

  /**
   * Acquire locks on files. Returns true if acquired immediately,
   * false if the caller should wait (use `waitForRelease` after calling).
   *
   * This is non-blocking — it attempts acquisition and returns the result.
   * Use `acquireOrWait` for a blocking acquire.
   *
   * When acquiring write locks, any existing read locks held by the same
   * owner are upgraded to write (re-entrant upgrade).
   */
  tryAcquire(files: string[], owner: string, mode: LockMode): boolean {
    if (!this.canAcquire(files, mode, owner)) return false

    const now = Date.now()
    for (const file of files) {
      const fileLocks = this.locks.get(file) ?? []

      // If upgrading from read to write, remove the old read lock first
      if (mode === 'write') {
        const existingIdx = fileLocks.findIndex((l) => l.owner === owner && l.mode === 'read')
        if (existingIdx !== -1) {
          fileLocks.splice(existingIdx, 1)
        }
      }

      // Avoid duplicate locks from the same owner on the same file
      const alreadyHeld = fileLocks.some((l) => l.owner === owner && l.mode === mode)
      if (!alreadyHeld) {
        fileLocks.push({ owner, mode, acquiredAt: now })
        this.locks.set(file, fileLocks)
      }

      // Update reverse index
      let ownerSet = this.ownerFiles.get(owner)
      if (!ownerSet) {
        ownerSet = new Set()
        this.ownerFiles.set(owner, ownerSet)
      }
      ownerSet.add(file)
    }
    return true
  }

  /**
   * Wait for locks to become available, then acquire them.
   * Returns when the locks are acquired.
   */
  async acquireOrWait(files: string[], owner: string, mode: LockMode): Promise<void> {
    while (!this.tryAcquire(files, owner, mode)) {
      await this.waitForRelease(files)
    }
  }

  /**
   * Release all locks held by an owner. O(k) where k = files held by owner.
   */
  release(owner: string): void {
    const files = this.ownerFiles.get(owner)
    if (!files) return

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

    this.ownerFiles.delete(owner)

    // Notify waiters for each released file
    this.notifyWaitersForFiles(files)
  }

  /**
   * Release specific files held by an owner.
   */
  releaseFiles(files: string[], owner: string): void {
    const ownerSet = this.ownerFiles.get(owner)

    for (const file of files) {
      const fileLocks = this.locks.get(file)
      if (!fileLocks) continue

      const remaining = fileLocks.filter((l) => l.owner !== owner)
      if (remaining.length === 0) {
        this.locks.delete(file)
      } else {
        this.locks.set(file, remaining)
      }

      // Update reverse index
      ownerSet?.delete(file)
    }

    if (ownerSet && ownerSet.size === 0) {
      this.ownerFiles.delete(owner)
    }

    // Notify waiters for each released file
    this.notifyWaitersForFiles(files)
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
   * Check if an owner holds any locks. O(1) via reverse index.
   */
  hasLocks(owner: string): boolean {
    const files = this.ownerFiles.get(owner)
    return files !== undefined && files.size > 0
  }

  /**
   * Wait for locks on specific files to be released.
   */
  waitForRelease(files: string[]): Promise<void> {
    return new Promise((resolve) => {
      for (const file of files) {
        let queue = this.waiters.get(file)
        if (!queue) {
          queue = []
          this.waiters.set(file, queue)
        }
        queue.push(resolve)
      }
    })
  }

  /**
   * Drain all locks and reject pending waiters.
   * Called when a session is stopped.
   */
  drain(): void {
    this.locks.clear()
    this.ownerFiles.clear()

    // Reject all waiters by resolving them (they'll fail on next tryAcquire)
    for (const queue of this.waiters.values()) {
      for (const w of queue) w()
    }
    this.waiters.clear()
  }

  private notifyWaitersForFiles(files: Set<string> | string[]): void {
    const notified = new Set<Waiter>()
    for (const file of files) {
      const queue = this.waiters.get(file)
      if (!queue) continue

      for (const w of queue) {
        if (!notified.has(w)) {
          notified.add(w)
          w()
        }
      }
      this.waiters.delete(file)
    }
  }

  /** Release all locks held by an owner. Called on agent disconnect. */
  releaseAll(owner: string): string[] {
    const files = this.ownerFiles.get(owner)
    if (!files) return []

    const released: string[] = []
    for (const file of files) {
      const fileLocks = this.locks.get(file)
      if (!fileLocks) continue

      const remaining = fileLocks.filter((l) => l.owner !== owner)
      if (remaining.length === 0) {
        this.locks.delete(file)
      } else {
        this.locks.set(file, remaining)
      }
      released.push(file)
    }

    this.ownerFiles.delete(owner)

    // Notify waiters for each released file
    this.notifyWaitersForFiles(files)

    return released
  }

  /** Clear all locks. */
  clear(): void {
    this.drain()
  }

  /** Acquire a single-file lock. Returns {ok, lock?, error?}. */
  acquire(file: string, owner: string, mode: LockMode): { ok: boolean; lock?: Lock; error?: string } {
    if (this.tryAcquire([file], owner, mode)) {
      const lock: Lock = { mode, owner, acquiredAt: Date.now() }
      return { ok: true, lock }
    }
    return { ok: false, error: `File '${file}' is locked` }
  }

  /** Release a single-file lock. */
  releaseFile(file: string, owner: string): boolean {
    const locks = this.locks.get(file)
    if (!locks) return false
    const idx = locks.findIndex((l) => l.owner === owner)
    if (idx === -1) return false
    locks.splice(idx, 1)
    if (locks.length === 0) this.locks.delete(file)
    this.ownerFiles.get(owner)?.delete(file)
    return true
  }

  /** List all active locks. */
  list(): Lock[] {
    const result: Lock[] = []
    for (const locks of this.locks.values()) result.push(...locks)
    return result
  }
}
