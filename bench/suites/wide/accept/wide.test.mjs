// What the eight helpers add up to when the release note is written: nothing
// here can pass until every task in the suite has run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCents } from '../src/cents.js'
import { chunk } from '../src/chunk.js'
import { clamp } from '../src/clamp.js'
import { dedupe } from '../src/dedupe.js'
import { slugify } from '../src/slug.js'
import { sum } from '../src/sum.js'
import { titleCase } from '../src/title.js'
import { truncate } from '../src/truncate.js'

const items = [
  { name: 'Widget', unit: 1250, qty: 2 },
  { name: 'widget', unit: 500, qty: 1 },
  { name: 'Gizmo', unit: 999999, qty: 3 },
]

const quantity = () => sum(items.map(item => item.qty))
const value = () => sum(items.map(item => item.unit * item.qty))

test('the release note counts what shipped and prices it', () => {
  assert.equal(quantity(), 6)
  assert.equal(formatCents(value()), '$30,029.97')
})

test('the release note names each thing that shipped once', () => {
  const names = dedupe(items.map(item => slugify(item.name)))
  assert.deepEqual(names, ['widget', 'gizmo'])
  assert.deepEqual(chunk(names, 2), [['widget', 'gizmo']])
})

test('the release note keeps its headline inside the limit', () => {
  const headline = titleCase('the   widget release')
  assert.equal(headline, 'The Widget Release')
  assert.equal(truncate(headline, 13), 'The Widget R\u2026')
  assert.equal(slugify(headline), 'the-widget-release')
})

test('the release note caps its figures', () => {
  assert.equal(clamp(value(), 0, 100000), 100000)
})
