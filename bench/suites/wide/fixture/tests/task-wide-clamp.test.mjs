// The test for task `wide-clamp`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { clamp } from '../src/clamp.js'

test('clamp holds a value inside the range', () => {
  assert.equal(clamp(5, 1, 10), 5)
  assert.equal(clamp(-2, 1, 10), 1)
  assert.equal(clamp(42, 1, 10), 10)
})

test('clamp treats both ends as inside the range', () => {
  assert.equal(clamp(1, 1, 10), 1)
  assert.equal(clamp(10, 1, 10), 10)
  assert.equal(clamp(0, 0, 0), 0)
})

test('clamp refuses an empty range', () => {
  assert.throws(() => clamp(1, 10, 0), RangeError)
})
