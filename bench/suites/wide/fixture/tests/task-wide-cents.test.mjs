// The test for task `wide-cents`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCents } from '../src/cents.js'

test('formatCents always shows two decimals', () => {
  assert.equal(formatCents(0), '$0.00')
  assert.equal(formatCents(5), '$0.05')
  assert.equal(formatCents(100), '$1.00')
})

test('formatCents groups the dollars', () => {
  assert.equal(formatCents(123456), '$1,234.56')
  assert.equal(formatCents(100000000), '$1,000,000.00')
})

test('formatCents puts the sign before the dollar sign', () => {
  assert.equal(formatCents(-500), '-$5.00')
  assert.equal(formatCents(-123456), '-$1,234.56')
})

test('formatCents rejects anything that is not a finite number', () => {
  assert.throws(() => formatCents('5'), TypeError)
  assert.throws(() => formatCents(Number.NaN), TypeError)
})
