// The test for task `mixed-format-wrap`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { formatLine, formatReport } from '../src/format.js'

test('formatReport writes the required fields first', () => {
  assert.deepEqual(formatReport('total=10 name=alice'), ['name=alice', 'total=10'])
  assert.deepEqual(formatReport('date=2026-09-01 total=10 name=a'), [
    'name=a',
    'total=10',
    'date=2026-09-01',
  ])
})

test('formatReport keeps the last value of a repeated field', () => {
  assert.deepEqual(formatReport('name=a total=1 date=x total=2'), ['name=a', 'total=2', 'date=x'])
})

test('formatReport stops at the field limit', () => {
  const many = 'a=1 b=2 c=3 d=4 e=5 f=6 g=7 h=8 i=9 name=n total=1'
  assert.deepEqual(formatReport(many), [
    'a=1',
    'b=2',
    'c=3',
    'd=4',
    'e=5',
    'f=6',
    'g=7',
    'h=8',
  ])
})

test('formatReport of a line with no fields is empty', () => {
  assert.deepEqual(formatReport(''), [])
})

test('formatLine still works', () => {
  assert.equal(formatLine(' name ', ' alice '), 'name=alice')
})
