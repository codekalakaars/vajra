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

test('a go model resolves the shared OpenCode key', () => {
  const { provider, apiKey } = createProvider('go/kimi-k3', { ...keys, go: keys.zen })

  assert.equal(provider.name, 'zen')
  assert.equal(apiKey, keys.zen)
})

test('a bare model is rejected — there is no default gateway', () => {
  assert.throws(
    () => createProvider('nvidia/nemotron-3-ultra-550b-a55b:free', keys),
    /Unknown provider/,
  )
  assert.throws(
    () => createProvider('claude-3.5-sonnet', keys),
    /Unknown provider/,
  )
})

test('key order in the map does not decide the key', () => {
  const reversed = { zen: keys.zen, anthropic: keys.anthropic }

  assert.equal(createProvider('anthropic/claude-3-opus-20240229', reversed).apiKey, keys.anthropic)
  assert.equal(createProvider('zen/kimi-k3', reversed).apiKey, keys.zen)
})

test('a provider with no key of its own does not fall back to another provider key', () => {
  // Sending a zen model with the anthropic key would authenticate the wrong
  // account against the wrong API.
  assert.throws(
    () => createProvider('zen/kimi-k3', { anthropic: keys.anthropic }),
    /No API key found for provider 'zen'/,
  )
})

test('no usable key is an error, not a silent empty string', () => {
  assert.throws(() => createProvider('anthropic/claude-3-opus-20240229', {}), /No API key/)
})

test('parseModelString accepts only zen/, go/ and anthropic/', () => {
  assert.deepEqual(parseModelString('zen/space-bunny-free'), { provider: 'zen', model: 'space-bunny-free' })
  assert.deepEqual(parseModelString('go/mimo-v2.5'), { provider: 'go', model: 'mimo-v2.5' })
  assert.deepEqual(parseModelString('anthropic/claude-3-opus-20240229'), { provider: 'anthropic', model: 'claude-3-opus-20240229' })
  assert.throws(() => parseModelString('openai/gpt-4o'), /Unknown provider/)
  assert.throws(() => parseModelString('nemotron-3-super-free'), /Unknown provider/)
})
