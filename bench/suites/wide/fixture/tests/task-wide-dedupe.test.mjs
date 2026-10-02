// The test for task `wide-dedupe`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { dedupe } from '../src/dedupe.js'

test('dedupe keeps the first of every item', () => {
  assert.deepEqual(dedupe([1, 2, 1, 3, 2]), [1, 2, 3])
  assert.deepEqual(dedupe(['a', 'b', 'a']), ['a', 'b'])
  assert.deepEqual(dedupe([1, 2, 3]), [1, 2, 3])
})

test('dedupe returns a new array and leaves the old one alone', () => {
  const input = [1, 1, 2]
  const out = dedupe(input)
  assert.deepEqual(input, [1, 1, 2])
  assert.notEqual(out, input)
  assert.deepEqual(dedupe([]), [])
})
