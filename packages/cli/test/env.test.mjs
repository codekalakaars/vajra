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
  resolveDefaultModel,
  readEnvFile,
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
    'openai/gpt-4o-mini',
  )
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
