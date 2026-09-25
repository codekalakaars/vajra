import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { chdir } from 'node:process'

const envUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'env.js')).href
const {
  writeEnvKey,
  findEnvPath,
  parseSetPair,
  resolveApiKeyForModel,
  resolveDefaultModel,
  readEnvFile,
  listAvailableModels,
  loadEnvIntoProcess,
  normalizeModelId,
} = await import(envUrl)

test('writeEnvKey creates and updates a KEY=VALUE line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-'))
  try {
    const envPath = join(dir, '.env')
    writeEnvKey(envPath, 'FOO', 'bar')
    assert.equal(readFileSync(envPath, 'utf-8'), 'FOO=bar\n')

    writeEnvKey(envPath, 'FOO', 'baz')
    assert.equal(readFileSync(envPath, 'utf-8'), 'FOO=baz\n')

    writeEnvKey(envPath, 'OTHER', '1')
    const content = readFileSync(envPath, 'utf-8')
    assert.match(content, /^FOO=baz$/m)
    assert.match(content, /^OTHER=1$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findEnvPath prefers an existing .env walking up from cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envfind-'))
  const prev = process.cwd()
  try {
    writeFileSync(join(dir, '.env'), 'MARKER=1\n')
    const nested = join(dir, 'a', 'b')
    // ensure nested exists under dir
    mkdirSync(nested, { recursive: true })
    chdir(nested)
    const found = findEnvPath()
    assert.equal(found, join(dir, '.env'))
  } finally {
    chdir(prev)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseSetPair parses KEY=VALUE', () => {
  assert.deepEqual(parseSetPair('FOO=bar'), { key: 'FOO', value: 'bar' })
  assert.deepEqual(parseSetPair('A=b=c'), { key: 'A', value: 'b=c' })
  assert.equal(parseSetPair('=bar'), null)
  assert.equal(parseSetPair('FOO'), null)
  assert.equal(parseSetPair(''), null)
})

test('resolveDefaultModel prefers VAJRA_MODEL then DEFAULT_MODEL', () => {
  assert.equal(
    resolveDefaultModel({ VAJRA_MODEL: 'a/b', DEFAULT_MODEL: 'c/d' }),
    'a/b',
  )
  assert.equal(
    resolveDefaultModel({ DEFAULT_MODEL: 'c/d' }),
    'c/d',
  )
  assert.equal(
    resolveDefaultModel({}),
    'zen/space-bunny-free',
  )
})

test('resolveApiKeyForModel only routes zen/* and go/* to the OpenCode key', () => {
  const env = {
    OPENCODE_API_KEY: 'oc-key',
  }
  assert.equal(resolveApiKeyForModel('zen/mimo-v2.5-free', undefined, env), 'oc-key')
  assert.equal(resolveApiKeyForModel('go/mimo-v2.5', undefined, env), 'oc-key')
  assert.equal(resolveApiKeyForModel('zen/mimo-v2.5-free', 'explicit', env), 'explicit')
  // Unsupported model ids get no credential at all.
  assert.equal(resolveApiKeyForModel('openai/gpt-4o', undefined, env), undefined)
  assert.equal(resolveApiKeyForModel('openai/gpt-4o', undefined, {}), undefined)
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
  const zenOnly = listAvailableModels({ OPENCODE_API_KEY: 'oc-key' })
  assert.ok(zenOnly.length > 0)
  assert.ok(zenOnly.every(m => m.id.startsWith('zen/')))

  // No other provider key unlocks anything.
  assert.deepEqual(listAvailableModels({}), [])
  assert.deepEqual(listAvailableModels({ OPENCODE_API_KEY: '  ' }), [])
})

test('loadEnvIntoProcess copies keys from the discovered .env into env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envload-'))
  const prev = process.cwd()
  try {
    writeFileSync(join(dir, '.env'), 'OPENCODE_API_KEY=oc-from-file\nEMPTY_KEY=\n')
    chdir(dir)
    const fakeEnv = {}
    const usedPath = loadEnvIntoProcess(fakeEnv)
    assert.equal(usedPath, join(dir, '.env'))
    assert.equal(fakeEnv.OPENCODE_API_KEY, 'oc-from-file')
    assert.equal(fakeEnv.EMPTY_KEY, undefined)
    // available models now see the loaded key
    assert.ok(listAvailableModels(fakeEnv).some(m => m.id.startsWith('zen/')))
  } finally {
    chdir(prev)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readEnvFile ignores comments and blanks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envread-'))
  try {
    const p = join(dir, '.env')
    writeFileSync(p, '# comment\n\nFOO=bar\n  SPACED = value  \n')
    const vals = readEnvFile(p)
    assert.equal(vals.FOO, 'bar')
    assert.equal(vals['SPACED'], 'value')
    assert.equal(vals['# comment'], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
