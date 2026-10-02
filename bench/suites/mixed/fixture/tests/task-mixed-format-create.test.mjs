// The test for task `mixed-format-create`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { formatLine } from '../src/format.js'

test('formatLine writes one field as name=value', () => {
  assert.equal(formatLine('name', 'alice'), 'name=alice')
  assert.equal(formatLine('total', '10'), 'total=10')
})

test('formatLine trims the space around the name and the value', () => {
  assert.equal(formatLine(' name ', ' alice '), 'name=alice')
  assert.equal(formatLine('total', '  '), 'total=')
})

test('formatLine rejects anything that is not a string', () => {
  assert.throws(() => formatLine(1, 'a'), TypeError)
  assert.throws(() => formatLine('a', null), TypeError)
})
