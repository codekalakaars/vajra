// Tests for the IPC client in project/launcher.ts.
//
// A worker that accepts a call and never answers must not hang its caller:
// the master loop has no watchdog of its own, so one stuck call stalls a
// whole run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// Shrink the grace added to a caller-requested timeout so the deadline tests
// finish in milliseconds. Set before the import: the module reads it once.
process.env.VAJRA_TOOL_TIMEOUT_GRACE_MS = '20'
const { WorkerHandle } = await import('../dist/project/launcher.js')

/** A child process that records sends and answers only when told to. */
function fakeChild() {
  const child = new EventEmitter()
  child.sent = []
  child.killed = false
  child.send = (message, callback) => {
    child.sent.push(message)
    callback?.(null)
    return true
  }
  child.kill = () => {
    child.killed = true
  }
  child.reply = (callId, payload) => {
    child.emit('message', { type: 'result', callId, ...payload })
  }
  return child
}

test('a call that is answered resolves with the result', async () => {
  const child = fakeChild()
  const handle = new WorkerHandle(child)

  const pending = handle.callTool('read_file', { path: 'a.ts' })
  child.reply(child.sent[0].callId, { ok: true, result: 'file contents' })

  assert.equal(await pending, 'file contents')
})

test('a call that is never answered rejects instead of hanging', async () => {
  const child = fakeChild()
  const handle = new WorkerHandle(child)

  // callTimeoutMs honours a timeout in the args, so this deadline is 10ms
  // plus the (shrunk) grace period — short enough to test without a clock.
  const started = Date.now()
  await assert.rejects(
    handle.callTool('run_command', { command: 'sleep 1000', timeout: 10 }),
    /timed out/,
  )
  assert.ok(Date.now() - started < 60_000, 'should not have waited the default timeout')
})

test('a timed-out worker is killed and refuses further calls', async () => {
  const child = fakeChild()
  const handle = new WorkerHandle(child)

  await assert.rejects(handle.callTool('run_command', { command: 'hang', timeout: 10 }), /timed out/)

  assert.ok(child.killed, 'a worker that blew its deadline should be killed')
  await assert.rejects(handle.callTool('read_file', { path: 'a.ts' }), /no longer running/)
})

test('a late reply after a timeout is ignored', async () => {
  const child = fakeChild()
  const handle = new WorkerHandle(child)

  const callId = []
  const pending = handle.callTool('run_command', { command: 'hang', timeout: 10 })
  callId.push(child.sent[0].callId)
  await assert.rejects(pending, /timed out/)

  // Must not throw on an unknown/settled call id.
  child.reply(callId[0], { ok: true, result: 'too late' })
})

test('worker exit rejects everything in flight', async () => {
  const child = fakeChild()
  const handle = new WorkerHandle(child)

  const pending = handle.callTool('read_file', { path: 'a.ts' })
  child.emit('exit', 1)

  await assert.rejects(pending, /exited with code 1/)
})

test('a failed send rejects the call', async () => {
  const child = fakeChild()
  child.send = (message, callback) => {
    callback?.(new Error('channel closed'))
    return false
  }
  const handle = new WorkerHandle(child)

  await assert.rejects(handle.callTool('read_file', { path: 'a.ts' }), /channel closed/)
})

test('stop rejects everything in flight', async () => {
  const child = fakeChild()
  const handle = new WorkerHandle(child)

  const pending = handle.callTool('read_file', { path: 'a.ts' })
  handle.stop()

  await assert.rejects(pending, /Project stopped/)
  assert.ok(child.killed)
})
