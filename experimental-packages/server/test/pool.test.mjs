// Tests for project/pool.ts — worker pool bookkeeping.
//
// Every task in a project shares one projectId, so the pool has to track
// workers individually. Keying them by project silently evicted all but the
// most recent worker, which then leaked: never stopped, never releasing its
// slot.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WorkerPool } from '../dist/project/pool.js'

/** A launcher that hands out inert handles and records stop() calls. */
function fakeLauncher() {
  const launched = []
  const launcher = async (job) => {
    const handle = {
      job,
      stopped: false,
      async callTool() {
        return 'ok'
      },
      stop() {
        handle.stopped = true
      },
    }
    launched.push(handle)
    return handle
  }
  return { launcher, launched }
}

function job(projectDir, taskId) {
  return {
    projectId: 'project-1', // every task in a project shares this
    projectDir,
    permissions: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: {} },
    allowUnenforced: false,
    taskId,
  }
}

test('concurrent workers in one project are all tracked', async () => {
  const { launcher } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 4, maxIdleWorkers: 4 }, launcher)

  const a = await pool.acquire(job('/tmp/a', 'task-1'))
  const b = await pool.acquire(job('/tmp/b', 'task-2'))
  const c = await pool.acquire(job('/tmp/c', 'task-3'))

  assert.notEqual(a, b)
  assert.equal(pool.stats().active, 3)

  pool.release(a, false)
  pool.release(b, false)
  pool.release(c, false)
  assert.equal(pool.stats().active, 0)

  await pool.drain()
})

test('drain stops every worker, including concurrent ones', async () => {
  const { launcher, launched } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 4, maxIdleWorkers: 4 }, launcher)

  await pool.acquire(job('/tmp/a', 'task-1'))
  await pool.acquire(job('/tmp/b', 'task-2'))
  await pool.acquire(job('/tmp/c', 'task-3'))

  await pool.drain()

  assert.equal(launched.length, 3)
  for (const handle of launched) {
    assert.ok(handle.stopped, `worker for ${handle.job.taskId} was never stopped`)
  }
})

test('releasing frees the slot it took', async () => {
  const { launcher } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 2, maxIdleWorkers: 0 }, launcher)

  const a = await pool.acquire(job('/tmp/a', 'task-1'))
  const b = await pool.acquire(job('/tmp/b', 'task-2'))
  pool.release(a, false)
  pool.release(b, false)

  // Both slots came back, so two more acquires must not block.
  const c = await pool.acquire(job('/tmp/c', 'task-3'))
  const d = await pool.acquire(job('/tmp/d', 'task-4'))
  assert.equal(pool.stats().active, 2)

  pool.release(c, false)
  pool.release(d, false)
  await pool.drain()
})

test('an idle worker is reused for the same project directory', async () => {
  const { launcher, launched } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 4, maxIdleWorkers: 4 }, launcher)

  const first = await pool.acquire(job('/tmp/a', 'task-1'))
  pool.release(first)
  assert.equal(pool.stats().idle, 1)

  const second = await pool.acquire(job('/tmp/a', 'task-2'))
  assert.equal(second, first, 'expected the idle worker to be reused')
  assert.equal(launched.length, 1)
  assert.equal(pool.stats().active, 1)

  pool.release(second, false)
  await pool.drain()
})

test('a drained pool can be used again', async () => {
  const { launcher } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 2, maxIdleWorkers: 1 }, launcher)

  await pool.acquire(job('/tmp/a', 'task-1'))
  await pool.drain()

  const handle = await pool.acquire(job('/tmp/a', 'task-2'))
  assert.ok(handle, 'acquire after drain should still hand out a worker')
  assert.equal(pool.stats().active, 1)

  await pool.drain()
})
