// The test for task `fan-leaf-4`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { taxOn } from '../src/leaf-4.js'

test('taxOn taxes an amount at the given rate', () => {
  assert.equal(taxOn(20, 0.2), 4)
  assert.equal(taxOn(1.5, 0.2), 0.3)
  assert.equal(taxOn(4.5, 0.05), 0.23)
})

test('taxOn on an amount of nothing is nothing', () => {
  assert.equal(taxOn(0, 0.2), 0)
})
