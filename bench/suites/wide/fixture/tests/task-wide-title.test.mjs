// The test for task `wide-title`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { titleCase } from '../src/title.js'

test('titleCase capitalises every word', () => {
  assert.equal(titleCase('hello world'), 'Hello World')
  assert.equal(titleCase('a'), 'A')
  assert.equal(titleCase('ALL CAPS'), 'All Caps')
})

test('titleCase squeezes whitespace between words', () => {
  assert.equal(titleCase('  MIXED   case  '), 'Mixed Case')
  assert.equal(titleCase('a\tb'), 'A B')
  assert.equal(titleCase(''), '')
})
