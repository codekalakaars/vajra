import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lookup } from '../src/lookup.js'

function expectedValue(index) {
  return `value-${index}-`.repeat(8).slice(0, -1)
}

describe('lookup', () => {
  it('finds the first item', () => {
    assert.equal(lookup('item-00001'), expectedValue(1))
  })

  it('finds a middle item', () => {
    assert.equal(lookup('item-01500'), expectedValue(1500))
  })

  it('finds the last item', () => {
    assert.equal(lookup('item-03000'), expectedValue(3000))
  })

  it('returns undefined for a missing id', () => {
    assert.equal(lookup('item-99999'), undefined)
    assert.equal(lookup('not-an-id'), undefined)
  })
})
