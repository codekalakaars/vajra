import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as library from '../src/library.js'

describe('library helpers', () => {
  it('adds two numbers', () => {
    assert.equal(library.add(2, 3), 5)
    assert.equal(library.add(-1, 1), 0)
  })

  it('subtracts two numbers', () => {
    assert.equal(library.sub(5, 3), 2)
    assert.equal(library.sub(1, 1), 0)
  })

  it('multiplies two numbers', () => {
    assert.equal(library.mul(4, 5), 20)
    assert.equal(library.mul(-2, 3), -6)
  })

  it('divides two numbers', () => {
    assert.equal(library.div(10, 2), 5)
    assert.equal(library.div(1, 4), 0.25)
  })

  it('clamps a number inside a range', () => {
    assert.equal(library.clamp(5, 0, 10), 5)
    assert.equal(library.clamp(-3, 0, 10), 0)
    assert.equal(library.clamp(15, 0, 10), 10)
  })

  it('rounds to two decimals', () => {
    assert.equal(library.round2(1.239), 1.24)
    assert.equal(library.round2(1.234), 1.23)
  })

  it('sums a list of numbers', () => {
    assert.equal(library.sum([1, 2, 3]), 6)
    assert.equal(library.sum([]), 0)
  })

  it('averages a list of numbers', () => {
    assert.equal(library.average([2, 4, 6]), 4)
    assert.equal(library.average([5]), 5)
  })
})
