// File lock manager — read-shared/write-exclusive locking.
// Multiple agents can read concurrently; only one can write at a time.

export type LockMode = 'shared' | 'exclusive'

export interface FileLock {
  file: string
  mode: LockMode
  owner: string
  acquiredAt: number
}

export interface LockResult {
  ok: boolean
  error?: string
  lock?: FileLock
}

/**
 * Manages file locks for a project.
 * In-memory only — stale locks from crashed agents don't block the project.
 */
export class FileLockManager {
  private locks = new Map<string, FileLock[]>()

  /**
   * Acquire a lock on a file.
   * - Shared locks: multiple owners can hold them simultaneously.
   * - Exclusive locks: only one owner at a time.
   */
  acquire(file: string, owner: string, mode: LockMode): LockResult {
    const existing = this.locks.get(file)

    if (!existing || existing.length === 0) {
      const lock: FileLock = { file, mode, owner, acquiredAt: Date.now() }
      this.locks.set(file, [lock])
      return { ok: true, lock }
    }

    const held = existing.find((l) => l.owner === owner)
    if (held) {
      if (held.mode === mode) return { ok: true, lock: held }
      return {
        ok: false,
        error: `Already hold a ${held.mode} lock on '${file}'. Release it first.`,
      }
    }

    if (existing.every((l) => l.mode === 'shared') && mode === 'shared') {
      const lock: FileLock = { file, mode, owner, acquiredAt: Date.now() }
      existing.push(lock)
      return { ok: true, lock }
    }

    return {
      ok: false,
      error: `File '${file}' is locked by ${existing[0].owner} (${existing[0].mode})`,
    }
  }

  /** Release a lock. Returns true if held and released. */
  release(file: string, owner: string): boolean {
    const existing = this.locks.get(file)
    if (!existing || existing.length === 0) return false

    const idx = existing.findIndex((l) => l.owner === owner)
    if (idx === -1) return false

    existing.splice(idx, 1)
    if (existing.length === 0) this.locks.delete(file)

    return true
  }

  /** Release all locks held by an owner. Called on agent disconnect. */
  releaseAll(owner: string): string[] {
    const released: string[] = []
    for (const [file, locks] of this.locks) {
      const idx = locks.findIndex((l) => l.owner === owner)
      if (idx !== -1) {
        locks.splice(idx, 1)
        released.push(file)
        if (locks.length === 0) this.locks.delete(file)
      }
    }
    return released
  }

  /** Check if a file is locked by someone other than the given owner. */
  isLocked(file: string, owner?: string): boolean {
    const locks = this.locks.get(file)
    if (!locks || locks.length === 0) return false
    if (owner) return locks.some((l) => l.owner !== owner)
    return true
  }

  /** Get all active locks. */
  list(): FileLock[] {
    const result: FileLock[] = []
    for (const locks of this.locks.values()) result.push(...locks)
    return result
  }

  /** Get all locks held by a specific owner. */
  listByOwner(owner: string): FileLock[] {
    const result: FileLock[] = []
    for (const locks of this.locks.values()) result.push(...locks.filter((l) => l.owner === owner))
    return result
  }

  /** Clear all locks. */
  clear(): void {
    this.locks.clear()
  }
}
