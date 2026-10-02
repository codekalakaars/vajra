// The test for task `fan-schema`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { taxRate } from '../src/schema.js'

test('taxRate knows the two kinds that are taxed', () => {
  assert.equal(taxRate('standard'), 0.2)
  assert.equal(taxRate('reduced'), 0.05)
})

test('taxRate charges nothing for anything else', () => {
  assert.equal(taxRate('other'), 0)
  assert.equal(taxRate(undefined), 0)
})
