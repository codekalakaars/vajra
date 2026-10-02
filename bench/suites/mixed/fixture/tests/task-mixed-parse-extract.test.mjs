// The test for task `mixed-parse-extract`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { extract, tokenize } from '../src/parse.js'

const tokens = tokenize('name=alice total=10')

test('extract reads one named field', () => {
  assert.equal(extract(tokens, 'name'), 'alice')
  assert.equal(extract(tokens, 'total'), '10')
})

test('extract says nothing when the field is not there', () => {
  assert.equal(extract(tokens, 'date'), null)
  assert.equal(extract([], 'name'), null)
})

test('extract hands back an empty value as it stands', () => {
  assert.equal(extract(tokenize('name='), 'name'), '')
})

test('tokenize still works', () => {
  assert.deepEqual(tokenize('  a  b '), ['a', 'b'])
})
