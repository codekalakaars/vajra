import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnAgentPool } from '../dist/index.js'

/**
 * The pool is the ceiling on real parallelism, so a run's own Worker count has
 * to reach it. Before `maxWorkers` existed the pool was sized from the sandbox
 * defaults whatever the caller asked for, and a fifth task waited on a fork that
 * was never allowed.
 */

const ALLOW = { read: true, write: true, edit: true, delete: false }

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-pool-size-'))
  writeFileSync(join(dir, 'a.txt'), 'alpha\n')
  return dir
}

const settledWithin = (promise, ms) =>
  Promise.race([
    promise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), ms)),
  ])

test('maxWorkers above the default lets that many tasks run at once', async () => {
  const dir = project()
  const pool = await spawnAgentPool(dir, 'pool-size-wide', { allowUnenforced: true, maxWorkers: 6 })
  try {
    const reads = Array.from({ length: 6 }, (_, i) =>
      pool.handleForTask(`t${i}`, () => ALLOW, () => {}).callTool('read_file', { path: join(dir, 'a.txt') }),
    )
    assert.equal(await settledWithin(Promise.all(reads), 30_000), true, 'six tasks should hold six workers')
  } finally {
    pool.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maxWorkers below the default holds the extra task until a worker is released', async () => {
  const dir = project()
  const pool = await spawnAgentPool(dir, 'pool-size-narrow', { allowUnenforced: true, maxWorkers: 2 })
  try {
    const path = join(dir, 'a.txt')
    const first = pool.handleForTask('t0', () => ALLOW, () => {})
    const second = pool.handleForTask('t1', () => ALLOW, () => {})
    await Promise.all([first.callTool('read_file', { path }), second.callTool('read_file', { path })])

    const third = pool.handleForTask('t2', () => ALLOW, () => {}).callTool('read_file', { path })
    assert.equal(await settledWithin(third, 1_500), false, 'a third task must wait for a worker')
    pool.releaseTask('t1')
    assert.equal(await settledWithin(third, 30_000), true, 'released, the third task gets the worker')
  } finally {
    pool.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
