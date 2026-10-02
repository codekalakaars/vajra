// What the bottleneck, the six leaves and the total make of one invoice.
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupLines, invoiceTotal, reportCents } from '../src/index.js'

const lines = [
  { unit: 19.99, qty: 3, kind: 'standard' },
  { unit: 2.5, qty: 4, discountPct: 20, kind: 'reduced' },
  { unit: 1, qty: 1, kind: 'other' },
]

test('every line is priced, discounted and taxed its own way', () => {
  assert.equal(invoiceTotal(lines), 81.36)
  assert.equal(reportCents(lines), 8136)
})

test('the total is what the leaves say it is', () => {
  assert.equal(invoiceTotal([{ unit: 10, qty: 2, kind: 'standard' }]), 24)
  assert.equal(invoiceTotal([{ unit: 5, qty: 1, discountPct: 10, kind: 'reduced' }]), 4.73)
  assert.equal(invoiceTotal([]), 0)
})

test('the lines are gathered by kind, in the order they came', () => {
  assert.deepEqual(Object.keys(groupLines(lines)), ['standard', 'reduced', 'other'])
  assert.deepEqual(groupLines(lines).other, [lines[2]])
})
