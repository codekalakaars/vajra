import { test } from 'node:test'
import assert from 'node:assert/strict'
import { greeting } from '../src/greeting.js'

test('greets by name', () => {
  assert.equal(greeting('Ada'), 'Hello, Ada!')
})
