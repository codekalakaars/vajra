// The test for task `chain-top`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { joinWords, splitWords, topWords } from '../src/steps.js'

test('topWords sorts by count, highest first', () => {
  assert.deepEqual(topWords({ a: 2, b: 1, c: 3 }, 2), [['c', 3], ['a', 2]])
  assert.deepEqual(topWords({ a: 5 }, 1), [['a', 5]])
  assert.deepEqual(topWords({}, 2), [])
})

test('topWords breaks a tie by first appearance', () => {
  assert.deepEqual(topWords({ a: 1, b: 1 }, 2), [['a', 1], ['b', 1]])
  assert.deepEqual(topWords({ z: 1, a: 1 }, 5), [['z', 1], ['a', 1]])
})

test('topWords refuses a limit below one', () => {
  assert.throws(() => topWords({ a: 1 }, 0), RangeError)
  assert.throws(() => topWords({ a: 1 }, 1.5), TypeError)
})

test('the earlier steps still work', () => {
  assert.deepEqual(splitWords('  a  b  '), ['a', 'b'])
  assert.equal(joinWords([' a ', '', 'b']), 'a b')
})
