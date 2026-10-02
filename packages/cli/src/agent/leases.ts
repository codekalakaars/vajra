import { posix } from 'node:path'
import { normalizeProjectPath } from '@codekalakaars/vajra-agent-process'
import type { ReadLockMode } from '../bench/params.js'
import type { TaskState } from './taskqueue.js'

export interface Lease {
  /** Normalized by `leaseKey`: project-relative when a project directory was given. */
  path: string
  mode: 'read' | 'write'
}

/** The task fields a lease is made of. */
export interface LeaseFiles {
  readFile: readonly string[]
  writeFile: readonly string[]
  deleteFile: readonly string[]
  createDir: readonly string[]
}

/**
 * The one spelling of a path that locks and conflicts compare.
 *
 * The lock manager compares strings, so `./src/a.js` and `src/a.js` would be two
 * files to it and two tasks writing the same file could run together. With the
 * project directory the path is made project-relative, exactly as permissions
 * see it; without one (the scheduler and the metrics, which only compare tasks
 * to each other) it is normalized lexically, which settles every relative
 * spelling.
 */
export function leaseKey(path: string, projectDir?: string): string {
  if (projectDir !== undefined) return normalizeProjectPath(projectDir, path)
  const normalized = posix.normalize(path.replace(/\\/g, '/'))
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/** ...and the same, with the id, for comparing two tasks to each other. */
export type LeasedTask = LeaseFiles & Pick<TaskState, 'id'>

/**
 * The file leases a task holds while it runs, and must be free to be admitted.
 *
 * `exclusive` gives every path — reads included — a `'write'` lease: two tasks
 * may not touch the same file at once, whatever they intend to do with it.
 *
 * `shared` gives read files a `'read'` lease, so several Workers can read the
 * same file together, while anything a task writes, deletes or creates is still
 * a `'write'` lease. A path named twice in one task is leased once, at the
 * stronger of the two modes: a task that reads and writes a file writes it.
 */
export function taskLeases(task: LeaseFiles, readLocks: ReadLockMode, projectDir?: string): Lease[] {
  const readMode: 'read' | 'write' = readLocks === 'shared' ? 'read' : 'write'
  const byPath = new Map<string, 'read' | 'write'>()
  const take = (paths: readonly string[], mode: 'read' | 'write'): void => {
    for (const raw of paths) {
      const path = leaseKey(raw, projectDir)
      if (mode === 'write' || !byPath.has(path)) byPath.set(path, mode)
    }
  }
  take(task.readFile, readMode)
  take(task.writeFile, 'write')
  take(task.deleteFile, 'write')
  take(task.createDir, 'write')
  return [...byPath].map(([path, mode]) => ({ path, mode }))
}

/** Every path a task touches, normalized and deduplicated, in plan order. */
export function leasePaths(task: LeaseFiles, projectDir?: string): string[] {
  return [...new Set(
    [...task.readFile, ...task.writeFile, ...task.deleteFile, ...task.createDir].map(path => leaseKey(path, projectDir)),
  )]
}

/**
 * True when only one of the two tasks could run at a time: they share a path
 * and at least one of them writes it. Under `shared` locks two tasks that only
 * read the same file are free to run together, and say so here.
 */
export function tasksConflict(a: LeasedTask, b: LeasedTask, readLocks: ReadLockMode): boolean {
  if (a.id === b.id) return false
  const bModes = new Map(taskLeases(b, readLocks).map(lease => [lease.path, lease.mode]))
  for (const lease of taskLeases(a, readLocks)) {
    const otherMode = bModes.get(lease.path)
    // Only a path both of them hold decides it: one of them writing is enough.
    if (otherMode !== undefined && (lease.mode === 'write' || otherMode === 'write')) return true
  }
  return false
}