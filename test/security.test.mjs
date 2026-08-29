// Checks for the ported security logic: env-file handling, permission config,
// and secret redaction.
//
// These modules are pure logic and already covered by Rust unit tests. What is
// tested here is specifically the JS boundary — that a HashMap arrives as a
// plain Record, that an optional config comes back as null rather than
// undefined, and that the on-disk format written through the binding is the
// same one the legacy CLI produced.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('../index.js')

function scratch() {
  return mkdtempSync(join(tmpdir(), 'vajra-sec-'))
}

test('parseEnv handles the shapes a real .env contains', () => {
  const vars = native.parseEnv(
    ['# comment', '', 'export QUOTED="bar baz"', "SINGLE='x'", 'URL=postgres://u:p@h/db?a=b', 'not a key=x'].join('\n')
  )

  const asObject = Object.fromEntries(vars.map((v) => [v.key, v.value]))
  assert.deepEqual(asObject, {
    QUOTED: 'bar baz',
    SINGLE: 'x',
    URL: 'postgres://u:p@h/db?a=b',
  })
  assert.equal(Object.getPrototypeOf(vars[0]), Object.prototype)
})

test('the generated sample exposes names but never values', () => {
  const sample = native.renderSampleEnv('SECRET=hunter2\nAPI_KEY=sk-abc123def\n')

  assert.match(sample, /SECRET=$/m)
  assert.match(sample, /API_KEY=$/m)
  assert.ok(!sample.includes('hunter2'), 'sample must not leak a secret value')
  assert.ok(!sample.includes('sk-abc123def'), 'sample must not leak a secret value')
})

test('ensureSampleEnv creates once and never clobbers', () => {
  const dir = scratch()
  const env = join(dir, '.env')
  const sample = join(dir, '.sample.env')
  writeFileSync(env, 'SECRET=hunter2\n')

  assert.equal(native.ensureSampleEnv(env, sample), true)
  assert.ok(!readFileSync(sample, 'utf8').includes('hunter2'))

  writeFileSync(sample, 'HAND_EDITED=\n')
  assert.equal(native.ensureSampleEnv(env, sample), false)
  assert.equal(readFileSync(sample, 'utf8'), 'HAND_EDITED=\n')

  rmSync(dir, { recursive: true, force: true })
})

test('redact replaces secret values wherever they appear', () => {
  const secrets = [
    { key: 'SECRET', value: 'hunter2' },
    { key: 'API_KEY', value: 'sk-abc123def' },
    { key: 'PORT', value: '80' },
  ]

  assert.equal(
    native.redact('token sk-abc123def and password hunter2\n', secrets),
    'token [REDACTED:API_KEY] and password [REDACTED:SECRET]\n'
  )

  // Embedded in a larger token, and repeated, still goes.
  assert.equal(native.redact('url=https://u:hunter2@h/db', secrets), 'url=https://u:[REDACTED:SECRET]@h/db')

  // Too short to match reliably; redacting it would mangle ordinary output.
  assert.equal(native.redact('listening on port 80\n', secrets), 'listening on port 80\n')
  assert.equal(native.minRedactableLength(), 4)
})

test('permissions default to read-only', () => {
  const config = native.defaultPermissions()

  assert.deepEqual(config.default, { read: true, write: false, edit: false, delete: false })
  assert.deepEqual(config.files, {})
  assert.equal(Object.getPrototypeOf(config.files), Object.prototype, 'HashMap should arrive as a plain Record')
})

test('permissions round-trip to disk in the legacy format', () => {
  const dir = scratch()
  const config = native.defaultPermissions()
  config.files['src/main.rs'] = { read: true, write: true, edit: true, delete: false }

  native.savePermissions(dir, config)

  // The on-disk shape must stay loadable by the legacy CLI.
  const raw = JSON.parse(readFileSync(join(dir, '.vajra-perms.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.deepEqual(raw.default, { read: true, write: false, edit: false, delete: false })
  assert.equal(raw.files['src/main.rs'].write, true)

  const loaded = native.loadPermissions(dir)
  assert.equal(loaded.files['src/main.rs'].edit, true)

  rmSync(dir, { recursive: true, force: true })
})

test('a missing config is null, and lookups fall back to the default', () => {
  const dir = scratch()
  assert.equal(native.loadPermissions(dir), null)

  const config = native.defaultPermissions()
  config.files['granted.txt'] = { read: true, write: true, edit: false, delete: false }

  assert.equal(native.permissionsFor(config, 'granted.txt').write, true)
  assert.equal(native.permissionsFor(config, 'other.txt').write, false)
  assert.equal(native.permissionsFor(config, 'other.txt').read, true)

  rmSync(dir, { recursive: true, force: true })
})

test('scanProject skips noise, flags masked env files, and uses portable paths', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'app.js'), '')
  writeFileSync(join(dir, '.env'), 'SECRET=x')
  writeFileSync(join(dir, '.sample.env'), 'SECRET=')
  writeFileSync(join(dir, '.hidden'), '')
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'index.js'), '')

  const entries = native.scanProject(dir)
  const names = entries.map((e) => e.name)

  assert.ok(names.includes('app.js'))
  assert.ok(names.includes('.sample.env'))
  assert.ok(names.includes('index.js'), 'should descend into src/')
  assert.ok(!names.includes('.hidden'))
  assert.ok(!names.includes('node_modules'))
  assert.ok(!names.includes('pkg'), 'must not descend into node_modules')

  assert.equal(entries.find((e) => e.name === '.env').isMasked, true)
  assert.equal(entries.find((e) => e.name === 'app.js').isMasked, false)

  // Config keys have to be portable, so paths are relative and /-separated
  // even where the platform separator is \.
  assert.equal(entries.find((e) => e.name === 'index.js').path, 'src/index.js')

  rmSync(dir, { recursive: true, force: true })
})

test('a scanned project can be turned into a permission config', () => {
  // The shape the harness will actually use: scan, then grant per path.
  const dir = scratch()
  writeFileSync(join(dir, 'app.js'), '')
  writeFileSync(join(dir, '.env'), 'SECRET=x')

  const config = native.defaultPermissions()
  for (const entry of native.scanProject(dir)) {
    if (entry.isDir) continue
    config.files[entry.path] = {
      read: !entry.isMasked,
      write: !entry.isMasked,
      edit: false,
      delete: false,
    }
  }

  native.savePermissions(dir, config)
  const loaded = native.loadPermissions(dir)

  assert.equal(loaded.files['app.js'].read, true)
  assert.equal(loaded.files['.env'].read, false, 'a masked env file should not be readable')

  rmSync(dir, { recursive: true, force: true })
})
