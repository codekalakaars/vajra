import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pipeline } from '../src/consumer.js'

describe('pipeline', () => {
  it('scales, clamps, rounds and averages', () => {
    // pipeline(values): multiply each by 2, clamp to [-5, 5], then return the
    // average rounded to two decimals.
    assert.equal(pipeline([1, 2, 3]), 3.67)
    assert.equal(pipeline([10, -10, 0]), 0)
    assert.equal(pipeline([2, 3]), 4.5)
    assert.equal(pipeline([]), 0)
  })
})
