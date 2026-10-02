// The test for task `fan-leaf-1`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { net } from '../src/leaf-1.js'

test('net rounds an amount to whole cents', () => {
  assert.equal(net(1.239), 1.24)
  assert.equal(net(10 / 3), 3.33)
  assert.equal(net(0), 0)
})

test('net leaves an amount that is already whole alone', () => {
  assert.equal(net(2), 2)
  assert.equal(net(1.5), 1.5)
  assert.equal(net(-1.239), -1.24)
})
