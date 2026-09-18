// Tests for provider/key routing in agent/providers/index.ts.
//
// The key has to travel with the provider. Picking one out of the key map
// separately — as the RPC handlers used to, with Object.values(keys)[0] —
// sends whichever key enumerated first to whichever provider the project
// actually uses, so a server holding two keys authenticates at random.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProvider, parseModelString } from '../dist/agent/providers/index.js'

const keys = {
  openrouter: 'sk-or-test',
  anthropic: 'sk-ant-test',
  zen: 'sk-zen-test',
}

test('an anthropic model resolves the anthropic key', () => {
  const { provider, apiKey, resolvedModel } = createProvider('anthropic/claude-3-opus-20240229', keys)

  assert.equal(provider.name, 'anthropic')
  assert.equal(apiKey, keys.anthropic)
  assert.equal(resolvedModel, 'claude-3-opus-20240229')
})

test('a zen model resolves the zen key', () => {
  const { provider, apiKey } = createProvider('zen/kimi-k3', keys)

  assert.equal(provider.name, 'zen')
  assert.equal(apiKey, keys.zen)
})

test('a bare model falls back to openrouter and its key', () => {
  const { provider, apiKey, resolvedModel } = createProvider('nvidia/nemotron-3-ultra-550b-a55b:free', keys)

  assert.equal(provider.name, 'openrouter')
  assert.equal(apiKey, keys.openrouter)
  assert.equal(resolvedModel, 'nvidia/nemotron-3-ultra-550b-a55b:free')
})

test('key order in the map does not decide the key', () => {
  const reversed = { zen: keys.zen, anthropic: keys.anthropic, openrouter: keys.openrouter }

  assert.equal(createProvider('anthropic/claude-3-opus-20240229', reversed).apiKey, keys.anthropic)
  assert.equal(createProvider('zen/kimi-k3', reversed).apiKey, keys.zen)
})

test('a provider with no key of its own falls back to the openrouter key', () => {
  const { apiKey } = createProvider('zen/kimi-k3', { openrouter: keys.openrouter })
  assert.equal(apiKey, keys.openrouter)
})

test('no usable key is an error, not a silent empty string', () => {
  assert.throws(() => createProvider('anthropic/claude-3-opus-20240229', {}), /No API key/)
})

test('parseModelString keeps openrouter meta-model slugs intact', () => {
  assert.deepEqual(parseModelString('openrouter/free'), { provider: 'openrouter', model: 'openrouter/free' })
  assert.deepEqual(parseModelString('openrouter/auto'), { provider: 'openrouter', model: 'openrouter/auto' })
})
