import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as library from '../src/library.js'
import { pipeline } from '../src/consumer.js'
import { lookup } from '../src/lookup.js'

describe('context suite acceptance', () => {
  it('library, consumer and lookup all work together', () => {
    assert.equal(library.add(1, 2), 3)
    assert.equal(pipeline([2, 3]), 4.5)
    assert.equal(lookup('item-00001').startsWith('value-1-'), true)
  })
})
