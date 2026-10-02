// The test for task `chain-join`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { joinWords, splitWords } from '../src/steps.js'

test('joinWords puts words back together', () => {
  assert.equal(joinWords([' a ', '', 'b']), 'a b')
  assert.equal(joinWords(['x']), 'x')
  assert.equal(joinWords([]), '')
})

test('splitWords still works', () => {
  assert.deepEqual(splitWords('  a  b  '), ['a', 'b'])
})
