// The test for task `mixed-parse-create`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../src/parse.js'

test('tokenize cuts a line into its fields', () => {
  assert.deepEqual(tokenize('name=alice total=10'), ['name=alice', 'total=10'])
  assert.deepEqual(tokenize('  a  b '), ['a', 'b'])
})

test('tokenize returns nothing for a line with no fields', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('   '), [])
})

test('tokenize rejects anything that is not a string', () => {
  assert.throws(() => tokenize(null), TypeError)
})
