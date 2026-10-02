// The test for task `wide-truncate`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { truncate } from '../src/truncate.js'

const ELLIPSIS = '\u2026'

test('truncate leaves short text alone', () => {
  assert.equal(truncate('hello', 10), 'hello')
  assert.equal(truncate('hello', 5), 'hello')
  assert.equal(truncate('', 4), '')
})

test('truncate marks a cut with one ellipsis', () => {
  assert.equal(truncate('hello', 3), 'he' + ELLIPSIS)
  assert.equal(truncate('hello', 1), ELLIPSIS)
  assert.equal(truncate('hello', 4), 'hel' + ELLIPSIS)
})

test('truncate refuses a limit below one', () => {
  assert.throws(() => truncate('hello', 0), RangeError)
  assert.throws(() => truncate('hello', -2), RangeError)
  assert.throws(() => truncate('hello', 2.5), TypeError)
})
