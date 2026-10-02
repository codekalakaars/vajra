// The test for task `mixed-validate-check`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { checkField, checkReport } from '../src/validate.js'

test('checkReport says nothing about a complete line', () => {
  assert.deepEqual(checkReport('name=alice total=10'), [])
})

test('checkReport names every required field the line leaves out', () => {
  assert.deepEqual(checkReport('name=alice'), ['missing: total'])
  assert.deepEqual(checkReport(''), ['missing: name', 'missing: total'])
})

test('checkReport names what is wrong before what is missing', () => {
  assert.deepEqual(checkReport('Name=alice total=10'), ['Name: bad key', 'missing: name'])
  assert.deepEqual(checkReport('name=a total='), ['total: empty value'])
})

test('checkField still works', () => {
  assert.equal(checkField('name', 'alice'), null)
})
