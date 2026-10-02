// The test for task `wide-slug`, and the command that decides whether it
// worked: a Worker may read this file and may not change it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slug.js'

test('slugify keeps words apart', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('Foo--Bar'), 'foo-bar')
  assert.equal(slugify('2026 Q1'), '2026-q1')
})

test('slugify squeezes runs of whitespace into one hyphen', () => {
  assert.equal(slugify('  A  B  '), 'a-b')
  assert.equal(slugify('a\tb\nc'), 'a-b-c')
})

test('slugify drops hyphens at both ends and nothing else', () => {
  assert.equal(slugify('---'), '')
  assert.equal(slugify('-lead-'), 'lead')
  assert.equal(slugify('already'), 'already')
})

test('slugify rejects anything that is not a string', () => {
  assert.throws(() => slugify(42), TypeError)
})
