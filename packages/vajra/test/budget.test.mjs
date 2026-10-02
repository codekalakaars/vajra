import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * K1: the characters-per-token ratio every estimate in the context batches rests
 * on.
 *
 * Without calibration, every decision here is a guess with a constant in it: a
 * model that packs code at two characters a token would be counted at four, a
 * pack would be sized at half its real cost, and compaction would fire either far
 * too late or far too early. The provider reports `prompt_tokens` for every
 * round, so the only question is whether the runtime bothers to learn from it.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const budgetUrl = pathToFileURL(join(dist, 'model', 'budget.js')).href
const windowUrl = pathToFileURL(join(dist, 'model', 'context-window.js')).href
const { ContextBudget, promptChars, resetCalibration } = await import(budgetUrl)
const { getModelLimit } = await import(windowUrl)

const MODEL = 'zen/test-model'

test('a fresh budget estimates at the seed ratio and knows the window', t => {
  t.after(resetCalibration)
  resetCalibration()
  const budget = new ContextBudget(MODEL)
  assert.equal(budget.ratio, 4)
  assert.equal(budget.window, getModelLimit(MODEL))
  assert.equal(budget.tokens('abcd'.repeat(10)), 10)
  assert.equal(budget.tokens(40), 10)
})

test('messageChars counts content, tool-call arguments and the per-message overhead', () => {
  const message = {
    role: 'assistant',
    content: 'hello',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  }
  // 'hello' + 'read_file' (9) + '{}' (2) + 16 for the role and separators.
  assert.equal(promptChars([message]), 5 + 9 + 2 + 16)
})

test('calibration converges on the ratio the provider actually counted', t => {
  t.after(resetCalibration)
  resetCalibration()
  const budget = new ContextBudget(MODEL)
  // A dense model: 10,000 characters it counted as 5,000 tokens, so 2 per token.
  for (let i = 0; i < 40; i++) budget.observe(10_000, 5_000)

  assert.ok(Math.abs(budget.ratio - 2) < 0.01, `converged to ${budget.ratio}, not 2`)
  // And the estimate now agrees with the provider rather than with the seed.
  assert.equal(budget.tokens(10_000), 5_000)
})

test('a moving average takes several rounds, so one odd report does not move it', t => {
  t.after(resetCalibration)
  resetCalibration()
  const budget = new ContextBudget(MODEL)
  budget.observe(8_000, 2_500)
  // 3.2 characters a token moves the seed from 4 by a third of the distance.
  assert.ok(budget.ratio > 3.7 && budget.ratio < 3.8, `one round moved it to ${budget.ratio}`)
})

test('an absurd ratio is a misreport and is ignored', t => {
  t.after(resetCalibration)
  resetCalibration()
  const budget = new ContextBudget(MODEL)

  // 10,000 characters reported as 10 tokens: 1000 per token.
  budget.observe(10_000, 10)
  assert.equal(budget.ratio, 4)
  // 10,000 characters reported as 10,000,000 tokens: a ten-thousandth each.
  budget.observe(10_000, 10_000_000)
  assert.equal(budget.ratio, 4)
  // A zero or negative count is not a measurement at all.
  budget.observe(10_000, 0)
  budget.observe(10_000, -5)
  assert.equal(budget.ratio, 4)
  assert.equal(budget.observe(0, 100), undefined)
})

test('a real ratio at either end of the accepted range still calibrates', t => {
  t.after(resetCalibration)
  resetCalibration()
  const budget = new ContextBudget(MODEL)
  for (let i = 0; i < 60; i++) budget.observe(12_000, 12_000)
  assert.ok(Math.abs(budget.ratio - 1) < 0.02, `converged to ${budget.ratio}, not 1`)
})

test('the calibration is shared by every Worker on the same model, and kept apart otherwise', t => {
  t.after(resetCalibration)
  resetCalibration()
  const a = new ContextBudget(MODEL)
  const b = new ContextBudget(MODEL)
  const other = new ContextBudget('zen/other-model')
  for (let i = 0; i < 30; i++) a.observe(6_000, 2_000)
  assert.equal(b.ratio, a.ratio, 'a second Worker on the same model inherits the calibration')
  assert.equal(other.ratio, 4, 'another model is not given this model\'s tokenizer')
})

test('resetCalibration puts every model back to the seed', t => {
  t.after(resetCalibration)
  resetCalibration()
  const budget = new ContextBudget(MODEL)
  for (let i = 0; i < 30; i++) budget.observe(9_000, 3_000)
  assert.ok(budget.ratio < 4)
  resetCalibration()
  assert.equal(budget.ratio, 4)
})

test('share is a fraction of the window, and 0 for a model with no window', () => {
  const budget = new ContextBudget(MODEL)
  assert.equal(budget.share(budget.window), 1)
  assert.equal(budget.share(budget.window / 2), 0.5)
  // Beyond 1 is not clamped: an overflowing prompt is more than the window, and
  // saying so is the point.
  assert.equal(budget.share(budget.window * 2), 2)
  assert.equal(new ContextBudget(MODEL).share(0), 0)
})