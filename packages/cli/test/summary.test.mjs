import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const summaryUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'agent', 'summary.js')).href
const nativeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'native.js')).href

const { buildSummaryIndex, searchSummary } = await import(summaryUrl)
const { isMaskedName } = await import(nativeUrl)

test('isMaskedName matches permissions.rs rule', () => {
  assert.equal(isMaskedName('.env'), true)
  assert.equal(isMaskedName('.env.local'), true)
  assert.equal(isMaskedName('.env.production'), true)
  assert.equal(isMaskedName('.env.development'), true)
  assert.equal(isMaskedName('.env.example'), false)
  assert.equal(isMaskedName('.env.sample'), false)
  assert.equal(isMaskedName('.sample.env'), false)
  assert.equal(isMaskedName('app.js'), false)
  assert.equal(isMaskedName('env'), false)
})

test('buildSummaryIndex never includes .env when isMasked is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-'))
  try {
    writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-SUPERSECRET123\nDB_PASSWORD=hunter2\n')
    writeFileSync(join(dir, 'app.js'), 'export function main() {}\nexport const x = 1\n')

    const entries = [
      { name: '.env', path: '.env', isDir: false, isMasked: true },
      { name: 'app.js', path: 'app.js', isDir: false, isMasked: false },
    ]

    const summary = buildSummaryIndex(dir, entries)
    const paths = summary.map(e => e.path)
    assert.ok(!paths.includes('.env'), '.env must not be indexed')
    assert.ok(paths.includes('app.js'))

    const search = searchSummary(summary, 'env secret OPENROUTER')
    assert.ok(!search.includes('SUPERSECRET'), 'search must not leak .env preview')
    assert.ok(!search.includes('.env\n') && !search.includes('.env ['), 'search must not list .env')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSummaryIndex excludes dist/ paths via SKIP_DIRS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-'))
  try {
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'export const built = true\n')
    writeFileSync(join(dir, 'src.ts'), 'export const src = true\n')

    const entries = [
      { name: 'bundle.js', path: 'dist/bundle.js', isDir: false, isMasked: false },
      { name: 'src.ts', path: 'src.ts', isDir: false, isMasked: false },
    ]

    const summary = buildSummaryIndex(dir, entries)
    const paths = summary.map(e => e.path)
    assert.ok(!paths.includes('dist/bundle.js'), 'dist/ path must be skipped')
    assert.ok(paths.includes('src.ts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSummaryIndex skips .min.js suffix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-'))
  try {
    writeFileSync(join(dir, 'lib.min.js'), 'var minified = 1;\n')
    writeFileSync(join(dir, 'ok.js'), 'export const ok = 1\n')

    const entries = [
      { name: 'lib.min.js', path: 'lib.min.js', isDir: false, isMasked: false },
      { name: 'ok.js', path: 'ok.js', isDir: false, isMasked: false },
    ]

    const summary = buildSummaryIndex(dir, entries)
    const paths = summary.map(e => e.path)
    assert.ok(!paths.includes('lib.min.js'))
    assert.ok(paths.includes('ok.js'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('searchSummary ranks partial term matches instead of requiring every term', () => {
  const summary = [
    { path: 'login.ts', symbols: ['loginUser'], preview: 'export function loginUser', lineCount: 10, importCount: 0, exportCount: 1 },
    { path: 'logout.ts', symbols: ['logoutUser'], preview: 'export function logoutUser', lineCount: 5, importCount: 0, exportCount: 1 },
    { path: 'auth/session.ts', symbols: ['Session'], preview: 'class Session', lineCount: 20, importCount: 2, exportCount: 3 },
  ]

  const results = searchSummary(summary, 'login auth')
  assert.ok(results.includes('login.ts'), 'login.ts should match (2 terms)')
  assert.ok(results.includes('auth/session.ts'), 'auth/session.ts should match (1 term)')
  assert.ok(!results.includes('logout.ts'), 'logout.ts matches neither term')
})
