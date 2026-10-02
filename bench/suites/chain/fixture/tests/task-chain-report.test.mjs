// The test for task `chain-report`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { reportLine, splitWords, topWords } from '../src/steps.js'

test('reportLine names the commonest words and how often they appear', () => {
  assert.equal(reportLine('b a b c', 2), 'b:2, a:1')
  assert.equal(reportLine('a a a', 1), 'a:3')
  assert.equal(reportLine('x y', 5), 'x:1, y:1')
})

test('reportLine says nothing about a text with no words', () => {
  assert.equal(reportLine('', 3), '')
})

test('the earlier steps still work', () => {
  assert.deepEqual(splitWords('  a  b  '), ['a', 'b'])
  assert.deepEqual(topWords({ a: 1, b: 1 }, 2), [['a', 1], ['b', 1]])
})
