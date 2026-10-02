// The test for task `wide-sum`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { sum } from '../src/sum.js'

test('sum adds a list of numbers', () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([1.25, 2.25]), 3.5)
  assert.equal(sum([-2, 2]), 0)
  assert.equal(sum([]), 0)
})

test('sum rejects anything that is not a finite number', () => {
  assert.throws(() => sum([1, '2']), TypeError)
  assert.throws(() => sum([1, Number.NaN]), TypeError)
})
