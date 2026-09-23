import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const skipUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tasks', 'skip.js')).href
const { evaluateSkipIfDetailed, evaluateSkipIf } = await import(skipUrl)

test('empty skipIf never skips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skip-'))
  try {
    const result = await evaluateSkipIfDetailed([], dir)
    assert.equal(result.shouldSkip, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown conditions do not force a skip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skip-unk-'))
  try {
    const result = await evaluateSkipIfDetailed(['always skip because I said so'], dir)
    assert.equal(result.shouldSkip, false)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /Unknown skipIf/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file exists / file missing evaluate as expected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skip-files-'))
  try {
    writeFileSync(join(dir, 'present.txt'), 'x')

    const existsHit = await evaluateSkipIfDetailed(['file exists: present.txt'], dir)
    assert.equal(existsHit.shouldSkip, true)

    const existsMiss = await evaluateSkipIfDetailed(['file exists: absent.txt'], dir)
    assert.equal(existsMiss.shouldSkip, false)

    const missingHit = await evaluateSkipIfDetailed(['file missing: absent.txt'], dir)
    assert.equal(missingHit.shouldSkip, true)

    const missingMiss = await evaluateSkipIfDetailed(['file missing: present.txt'], dir)
    assert.equal(missingMiss.shouldSkip, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('command passes: honours exit codes and rejects metacharacters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skip-cmd-'))
  try {
    const ok = await evaluateSkipIfDetailed(['command passes: node -e "process.exit(0)"'], dir)
    assert.equal(ok.shouldSkip, true)

    const fail = await evaluateSkipIfDetailed(['command passes: node -e "process.exit(1)"'], dir)
    assert.equal(fail.shouldSkip, false)

    const bad = await evaluateSkipIfDetailed(['command passes: echo a && echo b'], dir)
    assert.equal(bad.shouldSkip, false)
    assert.ok(bad.warnings.some(w => /command invalid/.test(w)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('all recognised conditions must hold to skip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skip-all-'))
  try {
    writeFileSync(join(dir, 'present.txt'), 'x')
    const mixed = await evaluateSkipIfDetailed(
      ['file exists: present.txt', 'file exists: absent.txt'],
      dir,
    )
    assert.equal(mixed.shouldSkip, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evaluateSkipIf back-compat returns boolean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skip-compat-'))
  try {
    assert.equal(await evaluateSkipIf([], dir), false)
    assert.equal(await evaluateSkipIf(['nope'], dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
