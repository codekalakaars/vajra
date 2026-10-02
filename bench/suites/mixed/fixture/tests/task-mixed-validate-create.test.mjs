// The test for task `mixed-validate-create`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { checkField } from '../src/validate.js'

test('checkField says nothing about a field that is fine', () => {
  assert.equal(checkField('name', 'alice'), null)
  assert.equal(checkField('total', '10'), null)
  assert.equal(checkField('line_2', 'x'), null)
})

test('checkField names a key that is not one', () => {
  assert.equal(checkField('Name', 'alice'), 'Name: bad key')
  assert.equal(checkField('1x', 'v'), '1x: bad key')
})

test('checkField names a value that is blank', () => {
  assert.equal(checkField('name', '   '), 'name: empty value')
  assert.equal(checkField('name', 7), 'name: empty value')
})

test('checkField reports a bad key before a blank value', () => {
  assert.equal(checkField('Name', ' '), 'Name: bad key')
})
