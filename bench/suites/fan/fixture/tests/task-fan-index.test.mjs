// The test for task `fan-index`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { groupLines, invoiceTotal, reportCents, taxRate } from '../src/index.js'

const lines = [
  { unit: 10, qty: 2, kind: 'standard' },
  { unit: 5, qty: 1, discountPct: 10, kind: 'reduced' },
]

test('invoiceTotal adds each line net of its discount, with tax on top', () => {
  assert.equal(invoiceTotal(lines), 28.73)
  assert.equal(invoiceTotal([]), 0)
})

test('invoiceTotal charges nothing for a kind that is not taxed', () => {
  assert.equal(invoiceTotal([{ unit: 3, qty: 2, kind: 'other' }]), 6)
})

test('reportCents is the same total in whole cents', () => {
  assert.equal(reportCents(lines), 2873)
})

test('groupLines gathers the lines by kind', () => {
  assert.deepEqual(groupLines(lines), { standard: [lines[0]], reduced: [lines[1]] })
})

test('the tax table is re-exported', () => {
  assert.equal(taxRate('standard'), 0.2)
})
