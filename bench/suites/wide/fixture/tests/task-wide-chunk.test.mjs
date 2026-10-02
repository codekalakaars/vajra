// The test for task `wide-chunk`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { chunk } from '../src/chunk.js'

test('chunk cuts a list into groups of size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]])
})

test('chunk keeps a short last group and copes with an empty list', () => {
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]])
  assert.deepEqual(chunk([], 3), [])
})

test('chunk refuses a size below one', () => {
  assert.throws(() => chunk([1, 2], 0), RangeError)
  assert.throws(() => chunk([1, 2], 1.5), TypeError)
})
