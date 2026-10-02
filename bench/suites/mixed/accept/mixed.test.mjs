// The whole toolkit, through the entry point the ten tasks built.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FIELD_ORDER,
  MAX_FIELDS,
  REQUIRED,
  describeReport,
  parseAll,
  renderReport,
  tokenize,
} from '../src/index.js'

const good = 'name=alice date=2026-09-01 total=10'

test('a complete line is accepted and written in field order', () => {
  assert.equal(describeReport(good), 'accepted: name=alice; total=10; date=2026-09-01')
})

test('an incomplete line is rejected for what it leaves out', () => {
  assert.equal(describeReport('name=alice'), 'rejected: missing: total')
  assert.equal(describeReport(''), 'rejected: missing: name, missing: total')
})

test('a line is checked before it is reported', () => {
  assert.equal(
    describeReport('Name=alice total='),
    'rejected: Name: bad key, total: empty value, missing: name'
  )
})

test('the entry point is the one the four modules make together', () => {
  assert.deepEqual(FIELD_ORDER, ['name', 'date', 'total'])
  assert.deepEqual(REQUIRED, ['name', 'total'])
  assert.equal(MAX_FIELDS, 8)
  assert.deepEqual(parseAll('name=alice name=bob total=1'), { name: 'bob', total: '1' })
  assert.deepEqual(tokenize('  a  b '), ['a', 'b'])
  assert.deepEqual(renderReport(good), {
    fields: ['name=alice', 'total=10', 'date=2026-09-01'],
    problems: [],
  })
})
