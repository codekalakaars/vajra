// Tests for agent/providers/limits.ts — the deadlines every provider shares.
//
// Without them a stalled response is unrecoverable: the agent loop awaits a
// stream that never produces another chunk and the project sits in `running`
// forever.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { withIdleTimeout, requestAbort } from '../dist/agent/providers/limits.js'

/** A stream that yields `count` chunks, then hangs forever. */
async function* stallsAfter(count) {
  for (let i = 0; i < count; i++) {
    yield `chunk-${i}`
  }
  await new Promise(() => {})
}

test('a stream that keeps producing is passed through untouched', async () => {
  async function* fine() {
    yield 'a'
    yield 'b'
  }

  const seen = []
  for await (const chunk of withIdleTimeout(fine(), 'test', () => {}, 1000)) {
    seen.push(chunk)
  }

  assert.deepEqual(seen, ['a', 'b'])
})

test('a stalled stream throws instead of hanging', async () => {
  const seen = []
  await assert.rejects(
    (async () => {
      for await (const chunk of withIdleTimeout(stallsAfter(2), 'test', () => {}, 20)) {
        seen.push(chunk)
      }
    })(),
    /stalled: no data for 20ms/,
  )

  assert.deepEqual(seen, ['chunk-0', 'chunk-1'], 'chunks before the stall still arrive')
})

test('a stall aborts the underlying request', async () => {
  let aborted = false

  await assert.rejects(
    (async () => {
      for await (const _ of withIdleTimeout(stallsAfter(0), 'test', () => { aborted = true }, 20)) {
        // drain
      }
    })(),
    /stalled/,
  )

  assert.ok(aborted, 'the stall handler should have aborted the request')
})

test('the caller signal aborts the request', () => {
  const caller = new AbortController()
  const { controller, dispose } = requestAbort(caller.signal)

  assert.equal(controller.signal.aborted, false)
  caller.abort(new Error('project stopped'))
  assert.equal(controller.signal.aborted, true)

  dispose()
})

test('an already-aborted caller signal aborts immediately', () => {
  const caller = new AbortController()
  caller.abort(new Error('already gone'))

  const { controller, dispose } = requestAbort(caller.signal)
  assert.equal(controller.signal.aborted, true)

  dispose()
})

test('dispose clears the deadline so the process can exit', () => {
  const { controller, dispose } = requestAbort()
  dispose()
  assert.equal(controller.signal.aborted, false)
})
