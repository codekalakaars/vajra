// The test for task `fan-leaf-3`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { discount } from '../src/leaf-3.js'

test('discount takes a percentage off', () => {
  assert.equal(discount(100, 10), 90)
  assert.equal(discount(5, 10), 4.5)
  assert.equal(discount(100, 0), 100)
})

test('discount never goes below zero', () => {
  assert.equal(discount(100, 150), 0)
  assert.equal(discount(100, 100), 0)
})
