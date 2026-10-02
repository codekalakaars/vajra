// The test for task `mixed-index-wire`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { PIPELINE, formatReport, renderReport, tokenize } from '../src/index.js'

test('renderReport renders and checks in one call', () => {
  assert.deepEqual(renderReport('name=alice total=10'), {
    fields: ['name=alice', 'total=10'],
    problems: [],
  })
})

test('renderReport reports what is missing', () => {
  assert.deepEqual(renderReport('name=alice'), {
    fields: ['name=alice'],
    problems: ['missing: total'],
  })
  assert.deepEqual(renderReport(''), {
    fields: [],
    problems: ['missing: name', 'missing: total'],
  })
})

test('the barrel still holds together', () => {
  assert.equal(PIPELINE, 'parse -> check -> format')
  assert.deepEqual(formatReport('total=10 name=alice'), ['name=alice', 'total=10'])
  assert.deepEqual(tokenize('  a  b '), ['a', 'b'])
})
