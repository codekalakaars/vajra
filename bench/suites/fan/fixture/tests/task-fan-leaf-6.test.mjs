// The test for task `fan-leaf-6`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { groupBy } from '../src/leaf-6.js'

test('groupBy collects the items that share a value', () => {
  const a1 = { k: 'a', n: 1 }
  const b1 = { k: 'b', n: 2 }
  const a2 = { k: 'a', n: 3 }
  assert.deepEqual(groupBy([a1, b1, a2], 'k'), { a: [a1, a2], b: [b1] })
})

test('groupBy keeps the keys in the order they were first seen', () => {
  assert.deepEqual(Object.keys(groupBy([{ k: 'b' }, { k: 'a' }, { k: 'b' }], 'k')), ['b', 'a'])
  assert.deepEqual(groupBy([], 'k'), {})
})
