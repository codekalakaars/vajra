// The test for task `mixed-parse-merge`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { extract, parseAll, tokenize } from '../src/parse.js'

test('parseAll reads every named field', () => {
  assert.deepEqual(parseAll('name=alice total=10'), { name: 'alice', total: '10' })
  assert.deepEqual(parseAll('name=alice junk total=10'), { name: 'alice', total: '10' })
})

test('parseAll keeps the last value of a repeated name', () => {
  assert.deepEqual(parseAll('name=alice name=bob'), { name: 'bob' })
})

test('parseAll of a line with no fields is empty', () => {
  assert.deepEqual(parseAll(''), {})
})

test('the earlier steps still work', () => {
  assert.deepEqual(tokenize('  a  b '), ['a', 'b'])
  assert.equal(extract(tokenize('name=alice'), 'name'), 'alice')
})
