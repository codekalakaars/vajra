// The test for task `chain-split`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { splitWords } from '../src/steps.js'

test('splitWords cuts a text into words', () => {
  assert.deepEqual(splitWords('  a  b  '), ['a', 'b'])
  assert.deepEqual(splitWords('a\tb\nc'), ['a', 'b', 'c'])
  assert.deepEqual(splitWords('one'), ['one'])
})

test('splitWords returns nothing for a text with no words', () => {
  assert.deepEqual(splitWords(''), [])
  assert.deepEqual(splitWords('   '), [])
})

test('splitWords rejects anything that is not a string', () => {
  assert.throws(() => splitWords(['a']), TypeError)
})
