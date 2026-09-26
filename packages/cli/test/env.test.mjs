import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const dist = join(import.meta.dirname, '..', 'dist')
const { parseSetPair, resolveApiKeyForModel, normalizeModelId, listAvailableModels } =
  await import(pathToFileURL(join(dist, 'env.js')).href)
const { writeAuth, readAuth, clearAuth } = await import(pathToFileURL(join(dist, 'auth.js')).href)

/** A private VAJRA_HOME so auth.json lookups never touch the real one. */
function inHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'vajra-auth-'))
  const env = { VAJRA_HOME: home }
  try {
    return fn(home, env)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('parseSetPair parses KEY=VALUE', () => {
  assert.deepEqual(parseSetPair('FOO=bar'), { key: 'FOO', value: 'bar' })
  assert.deepEqual(parseSetPair('A=b=c'), { key: 'A', value: 'b=c' })
  assert.equal(parseSetPair('=bar'), null)
  assert.equal(parseSetPair('FOO'), null)
  assert.equal(parseSetPair(''), null)
})

test('resolveApiKeyForModel: explicit > env > auth.json', () => {
  inHome((_home, env) => {
    writeAuth({ OPENCODE_API_KEY: 'stored-key' }, env)

    assert.equal(
      resolveApiKeyForModel('zen/mimo-v2.5-free', undefined, env),
      'stored-key',
      'stored key is used when the shell has none',
    )
    assert.equal(
      resolveApiKeyForModel('zen/mimo-v2.5-free', undefined, { ...env, OPENCODE_API_KEY: 'env-key' }),
      'env-key',
      'a shell-exported key beats auth.json',
    )
    assert.equal(
      resolveApiKeyForModel('zen/mimo-v2.5-free', 'explicit', { ...env, OPENCODE_API_KEY: 'env-key' }),
      'explicit',
      '--api-key always wins',
    )
    // Unsupported model ids get no credential at all.
    assert.equal(resolveApiKeyForModel('openai/gpt-4o', undefined, env), undefined)
  })
})

test('resolveApiKeyForModel routes only zen/* and go/* to the OpenCode key', () => {
  inHome((_home, env) => {
    writeAuth({ OPENCODE_API_KEY: 'stored-key' }, env)
    assert.equal(resolveApiKeyForModel('zen/mimo-v2.5-free', undefined, env), 'stored-key')
    assert.equal(resolveApiKeyForModel('go/mimo-v2.5', undefined, env), 'stored-key')
    assert.equal(resolveApiKeyForModel('openai/gpt-4o', undefined, env), undefined)
  })
})

test('normalizeModelId rejects anything but zen/* and go/*', () => {
  assert.equal(normalizeModelId(' zen/space-bunny-free '), 'zen/space-bunny-free')
  assert.equal(normalizeModelId('go/mimo-v2.5'), 'go/mimo-v2.5')
  assert.throws(() => normalizeModelId('openai/gpt-4o'), /Unsupported model 'openai\/gpt-4o'/)
  assert.throws(() => normalizeModelId('nvidia/nemotron-3-super-120b-a12b:free'), /Unsupported model/)
  assert.throws(() => normalizeModelId('   '), /Model id is required/)
  assert.throws(() => normalizeModelId('zen/bad id'), /Invalid model id/)
})

test('listAvailableModels filters presets by configured keys', () => {
  inHome((_home, env) => {
    const zenOnly = listAvailableModels({ ...env, OPENCODE_API_KEY: 'oc-key' })
    assert.ok(zenOnly.length > 0)
    assert.ok(zenOnly.every(m => m.id.startsWith('zen/')))

    // No key at all: no presets.
    assert.deepEqual(listAvailableModels(env), [])

    // A key in auth.json unlocks the same presets the env var does —
    // even when the env var is blank.
    writeAuth({ OPENCODE_API_KEY: 'oc-key' }, env)
    assert.ok(listAvailableModels(env).length > 0)
    assert.ok(listAvailableModels({ ...env, OPENCODE_API_KEY: '  ' }).length > 0)
  })
})

test('auth store: write, merge, clear', () => {
  inHome((_home, env) => {
    assert.deepEqual(readAuth(env), {})

    writeAuth({ OPENCODE_API_KEY: '  sk-test-123  ' }, env)
    assert.deepEqual(readAuth(env), { OPENCODE_API_KEY: 'sk-test-123' }, 'values are trimmed')

    assert.equal(clearAuth(env), true)
    assert.deepEqual(readAuth(env), {})
    assert.equal(clearAuth(env), false, 'second clear is a no-op')
  })
})
