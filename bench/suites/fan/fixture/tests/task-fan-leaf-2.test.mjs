// The test for task `fan-leaf-2`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { lineTotal } from '../src/leaf-2.js'

test('lineTotal prices a line to whole cents', () => {
  assert.equal(lineTotal(2.5, 4), 10)
  assert.equal(lineTotal(0.1, 3), 0.3)
  assert.equal(lineTotal(19.99, 3), 59.97)
})

test('lineTotal copes with a quantity of one and a quantity of none', () => {
  assert.equal(lineTotal(7.5, 1), 7.5)
  assert.equal(lineTotal(7.5, 0), 0)
})
