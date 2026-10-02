// The four steps on one file, run through end to end.
import test from 'node:test'
import assert from 'node:assert/strict'
import { joinWords, reportLine, splitWords, topWords } from '../src/steps.js'

const text = 'the quick brown fox jumps over the lazy dog the fox'

test('the steps read a text the same way all the way down', () => {
  assert.equal(splitWords(text).length, 11)
  assert.equal(joinWords(splitWords('  the   fox  ')), 'the fox')
})

test('the steps rank the words of a text', () => {
  assert.equal(reportLine(text, 3), 'the:3, fox:2, quick:1')
  assert.deepEqual(topWords({ quick: 1, fox: 2, the: 3 }, 2), [['the', 3], ['fox', 2]])
})

test('the steps break a tie by first appearance', () => {
  assert.equal(reportLine('  the   FOX  the ', 2), 'the:2, FOX:1')
})
