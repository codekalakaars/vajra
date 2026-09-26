import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const {
  expectedOutcome,
  isSatisfied,
  rollup,
  worse,
} = await import(pathToFileURL(join(root, 'verdict.js')).href)

const task = (over = {}) => ({
  id: 't1',
  phase: 1,
  kind: 'test',
  targetFiles: ['src/auth.ts'],
  successCriteria: [{ id: 'c1', type: 'test' }],
  ...over,
})

test('Phase One test task expects a failing assertion', () => {
  assert.equal(expectedOutcome(task()), 'fail_on_assertion')
})

test('Phase One stub task expects a pass', () => {
  assert.equal(expectedOutcome(task({ kind: 'stub' })), 'pass')
})

test('later phase expects a pass regardless of kind', () => {
  assert.equal(expectedOutcome(task({ phase: 2, kind: 'test' })), 'pass')
  assert.equal(expectedOutcome(task({ phase: 2 })), 'pass')
})

test('expectation inversion: the same verdict means opposite things', () => {
  // This is the whole point of the contract. A test failing in Phase One is the
  // objective; the identical test failing in Phase Two is a defect.
  assert.equal(isSatisfied('fail_on_assertion', 'failed_assertion'), true)
  assert.equal(isSatisfied('pass', 'failed_assertion'), false)
})

test('an outright pass satisfies a pass-expecting task but not a Phase One test', () => {
  assert.equal(isSatisfied('pass', 'passed'), true)
  assert.equal(isSatisfied('fail_on_assertion', 'passed'), false)
})

test('flaky and timeout never satisfy, in any phase', () => {
  for (const expected of ['pass', 'fail_on_assertion']) {
    assert.equal(isSatisfied(expected, 'flaky'), false, `${expected}/flaky`)
    assert.equal(isSatisfied(expected, 'timeout'), false, `${expected}/timeout`)
  }
})

test('a broken test never satisfies a Phase One gate', () => {
  // The trap: an import error looks identical to a failing test to a naive
  // runner. If this were accepted, a bad stub would sail through the gate.
  assert.equal(isSatisfied('fail_on_assertion', 'failed_environment'), false)
  assert.equal(isSatisfied('fail_on_assertion', 'not_collected'), false)
})

test('rollup picks the worst outcome', () => {
  const t = (verdict) => ({ id: 'x', target: { kind: 'file', ref: 'f.ts' }, verdict, message: '' })
  assert.equal(rollup([t('passed'), t('passed')]), 'passed')
  assert.equal(rollup([t('passed'), t('failed_assertion')]), 'failed_assertion')
  assert.equal(
    rollup([t('failed_assertion'), t('failed_environment')]),
    'failed_environment',
  )
  assert.equal(rollup([t('passed'), t('scope_violation')]), 'scope_violation')
})

test('an empty run is not a pass', () => {
  // A task with no results must never verify green — that is what a runner
  // collecting nothing would look like.
  assert.equal(rollup([]), 'not_collected')
})

test('severity ordering', () => {
  assert.equal(worse('passed', 'failed_assertion'), 'failed_assertion')
  assert.equal(worse('failed_assertion', 'passed'), 'failed_assertion')
  assert.equal(worse('timeout', 'scope_violation'), 'timeout')
})
