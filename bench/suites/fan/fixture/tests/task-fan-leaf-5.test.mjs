// The test for task `fan-leaf-5`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { toCents } from '../src/leaf-5.js'

test('toCents turns an amount into whole cents', () => {
  assert.equal(toCents(28.73), 2873)
  assert.equal(toCents(0.1), 10)
  assert.equal(toCents(2), 200)
})

test('toCents rounds a negative amount the same way', () => {
  assert.equal(toCents(-1.5), -150)
  assert.equal(toCents(0), 0)
})
