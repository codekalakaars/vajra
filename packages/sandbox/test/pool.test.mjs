import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const poolUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'pool.js')).href
const { WorkerPool } = await import(poolUrl)

/**
 * A worker that records its calls and can be told to die. `callTool` resolves
 * only when `gate` allows it, so a test can hold a call in flight across a
 * crash and prove the call belonged to *that* worker alone.
 */
function makeFactory() {
  const workers = []
  const factory = async () => {
    const record = { id: workers.length, calls: [], closed: 0, dead: false, gates: [] }
    const worker = {
      async callTool(tool, args) {
        if (record.dead) throw new Error(`worker ${record.id} is dead`)
        record.calls.push({ tool, args })
        const gate = record.gates.shift()
        if (gate) await gate
        return `worker-${record.id}:${tool}`
      },
      close() {
        record.closed++
        record.dead = true
      },
    }
    workers.push(record)
    return worker
  }
  return { factory, workers }
}

const deferred = () => {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

test('a warm worker is reused instead of forking a second one', async () => {
  const { factory, workers } = makeFactory()
  const pool = new WorkerPool({ maxWorkers: 2, launch: factory })

  const first = await pool.acquire()
  first.release()
  const second = await pool.acquire()

  assert.equal(workers.length, 1, 'reuse must not fork')
  assert.notEqual(first.id, second.id, 'a released lease is a new lease')
  assert.equal((await second.callTool('read_file', {})).startsWith('worker-0'), true)
  assert.equal(pool.stats().created, 1)
  await pool.drain()
})

test('acquiring past the cap queues instead of forking', async () => {
  const { factory, workers } = makeFactory()
  const pool = new WorkerPool({ maxWorkers: 2, launch: factory })

  const a = await pool.acquire()
  const b = await pool.acquire()
  const third = deferred()
  const waiting = pool.acquire().then(v => third.resolve(v))

  assert.equal(workers.length, 2, 'must not exceed the cap')
  assert.equal(pool.stats().waiting, 1)

  a.release()
  const lease = await third.promise
  assert.equal(pool.stats().waiting, 0)
  assert.equal(workers.length, 2, 'the freed slot is reused, not forked')
  assert.equal((await lease.callTool('ls', {})).startsWith('worker-'), true)
  b.release()
  lease.release()
  await waiting
  await pool.drain()
})

test('a dead worker costs only its own lease — the isolation property', async () => {
  const { factory, workers } = makeFactory()
  const pool = new WorkerPool({ maxWorkers: 2, launch: factory })

  const doomed = await pool.acquire()
  const survivor = await pool.acquire()
  assert.notEqual(doomed.id, survivor.id)

  // Hold a call open on the healthy worker across the crash.
  const held = deferred()
  workers[1].gates.push(held.promise)
  const inFlight = survivor.callTool('npm', { command: 'test' })

  doomed.markDead('killed by OOM')

  assert.equal(workers[0].closed, 1, 'the dead worker is closed')
  assert.equal(workers[1].closed, 0, 'the healthy worker is untouched')

  // The healthy worker's in-flight call still resolves.
  held.resolve()
  assert.equal(await inFlight, 'worker-1:npm')

  // And the freed slot is replaced rather than lost.
  const replacement = await pool.acquire()
  assert.equal(workers.length, 3, 'a replacement worker is forked')
  assert.equal((await replacement.callTool('ls', {})).startsWith('worker-2'), true)
  assert.equal(workers[1].closed, 0, 'the healthy worker is still not closed')

  replacement.release()
  survivor.release()
  await pool.drain()
})

test('a lease refuses calls after release and after death', async () => {
  const { factory } = makeFactory()
  const pool = new WorkerPool({ maxWorkers: 1, launch: factory })

  const lease = await pool.acquire()
  lease.release()
  await assert.rejects(() => lease.callTool('ls', {}), /already released/)

  const next = await pool.acquire()
  next.markDead()
  await assert.rejects(() => next.callTool('ls', {}), /no longer available/)
  await pool.drain()
})

test('idle workers are destroyed once they exceed the warm limit', async () => {
  const { factory, workers } = makeFactory()
  const pool = new WorkerPool({ maxWorkers: 3, maxIdle: 1, launch: factory })

  const leases = [await pool.acquire(), await pool.acquire(), await pool.acquire()]
  assert.equal(workers.length, 3)
  for (const lease of leases) lease.release()

  // Only maxIdle is kept warm; the rest are closed on release.
  assert.equal(pool.stats().idle, 1)
  const closed = workers.filter(w => w.closed > 0).length
  assert.equal(closed, 2, 'surplus workers are closed, not parked')
  await pool.drain()
})

test('keepIdle false closes every worker on release', async () => {
  const { factory, workers } = makeFactory()
  const pool = new WorkerPool({ maxWorkers: 2, keepIdle: false, launch: factory })

  const lease = await pool.acquire()
  lease.release()

  assert.equal(pool.stats().idle, 0)
  assert.equal(workers[0].closed, 1)
  await pool.drain()
})

test('drain closes everything and rejects anyone waiting', async () => {
  const { factory, workers } = makeFactory()
  const pool = new WorkerPool({ maxWorkers: 1, launch: factory })

  const held = await pool.acquire()
  const waiting = pool.acquire()
  await pool.drain()

  await assert.rejects(() => waiting, /draining/)
  held.release()
  assert.equal(workers.length, 1)
  await pool.drain()
  await assert.rejects(() => pool.acquire(), /draining/)
})

test('a fork that fails surfaces to the caller and frees the slot', async () => {
  let attempts = 0
  const pool = new WorkerPool({
    maxWorkers: 1,
    launch: async () => {
      attempts++
      if (attempts === 1) throw new Error('fork failed')
      return { callTool: async () => 'ok', close() {} }
    },
  })

  await assert.rejects(() => pool.acquire(), /fork failed/)
  const recovered = await pool.acquire()
  assert.equal(await recovered.callTool('ls', {}), 'ok')
  recovered.release()
  await pool.drain()
})
