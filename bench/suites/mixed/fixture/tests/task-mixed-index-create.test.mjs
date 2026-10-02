// The test for task `mixed-index-create`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { FIELD_ORDER, PIPELINE, REQUIRED, formatLine, tokenize } from '../src/index.js'

test('the barrel hands out the whole toolkit', () => {
  assert.equal(typeof tokenize, 'function')
  assert.equal(typeof formatLine, 'function')
})

test('the barrel names the order the report runs in', () => {
  assert.equal(PIPELINE, 'parse -> check -> format')
})

test('the barrel hands out the shared field order', () => {
  assert.deepEqual(FIELD_ORDER, ['name', 'date', 'total'])
  assert.deepEqual(REQUIRED, ['name', 'total'])
})
