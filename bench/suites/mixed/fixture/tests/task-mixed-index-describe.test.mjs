// The test for task `mixed-index-describe`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { PIPELINE, describeReport, renderReport, tokenize } from '../src/index.js'

test('describeReport accepts a line that is complete', () => {
  assert.equal(describeReport('name=alice total=10'), 'accepted: name=alice; total=10')
})

test('describeReport rejects a line that is not, and says why', () => {
  assert.equal(describeReport('name=alice'), 'rejected: missing: total')
  assert.equal(describeReport(''), 'rejected: missing: name, missing: total')
  assert.equal(
    describeReport('Name=alice total=10'),
    'rejected: Name: bad key, missing: name'
  )
})

test('the barrel still holds together', () => {
  assert.equal(PIPELINE, 'parse -> check -> format')
  assert.deepEqual(renderReport('').fields, [])
  assert.deepEqual(tokenize('  a  b '), ['a', 'b'])
})
