// Tests for project/pool.ts — permission-based worker reuse.
//
// Verifies that a pooled worker is NOT reused when the next job has
// a different permission identity, preventing over/under-permission.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WorkerPool } from '../dist/project/pool.js'

function fakeLauncher() {
  const launched = []
  const launcher = async (job) => {
    const handle = {
      job,
      stopped: false,
      async callTool() { return 'ok' },
      stop() { handle.stopped = true },
    }
    launched.push(handle)
    return handle
  }
  return { launcher, launched }
}

function job(projectDir, taskId, files = {}) {
  return {
    projectId: 'project-1',
    projectDir,
    permissions: {
      version: 1,
      default: { read: false, write: false, edit: false, delete: false },
      files,
    },
    allowUnenforced: false,
    taskId,
    allowedTools: ['read_file', 'write_file'],
  }
}

test('worker is reused for identical permission identity', async () => {
  const { launcher, launched } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 4, maxIdleWorkers: 4 }, launcher)

  const perms = { 'src/a.ts': { read: true, write: false, edit: false, delete: false } }
  const h1 = await pool.acquire(job('/tmp/proj', 't1', perms))
  pool.release(h1)
  assert.equal(launched.length, 1)

  const h2 = await pool.acquire(job('/tmp/proj', 't2', perms))
  assert.equal(h2, h1, 'expected reuse for same permission identity')
  assert.equal(launched.length, 1)

  pool.release(h2, false)
  await pool.drain()
})

test('worker is NOT reused when file permissions differ', async () => {
  const { launcher, launched } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 4, maxIdleWorkers: 4 }, launcher)

  const h1 = await pool.acquire(job('/tmp/proj', 't1', {
    'src/a.ts': { read: true, write: false, edit: false, delete: false },
  }))
  pool.release(h1)
  assert.equal(launched.length, 1)

  // Different file set — should fork a new worker
  const h2 = await pool.acquire(job('/tmp/proj', 't2', {
    'src/b.ts': { read: true, write: true, edit: true, delete: false },
  }))
  assert.notEqual(h2, h1, 'should not reuse worker with different permissions')
  assert.equal(launched.length, 2)

  pool.release(h2, false)
  await pool.drain()
})

test('worker is NOT reused when allowed tools differ', async () => {
  const { launcher, launched } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 4, maxIdleWorkers: 4 }, launcher)

  const perms = { 'src/a.ts': { read: true, write: false, edit: false, delete: false } }
  const h1 = await pool.acquire(job('/tmp/proj', 't1', perms))
  pool.release(h1)

  // Same files but different tools
  const job2 = job('/tmp/proj', 't2', perms)
  job2.allowedTools = ['read_file', 'write_file', 'edit_file']
  const h2 = await pool.acquire(job2)
  assert.notEqual(h2, h1, 'should not reuse worker with different tools')
  assert.equal(launched.length, 2)

  pool.release(h2, false)
  await pool.drain()
})

test('worker is NOT reused across different project directories', async () => {
  const { launcher, launched } = fakeLauncher()
  const pool = new WorkerPool({ maxConcurrentWorkers: 4, maxIdleWorkers: 4 }, launcher)

  const h1 = await pool.acquire(job('/tmp/proj-a', 't1'))
  pool.release(h1)

  const h2 = await pool.acquire(job('/tmp/proj-b', 't2'))
  assert.notEqual(h2, h1, 'should not reuse across directories')
  assert.equal(launched.length, 2)

  pool.release(h2, false)
  await pool.drain()
})
