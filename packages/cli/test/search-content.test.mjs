import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const handleUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tools', 'handle.js')).href
const { createToolHandle } = await import(handleUrl)

const protocolUrl = pathToFileURL(
  join(import.meta.dirname, '..', '..', 'protocol', 'dist', 'index.js'),
).href
const { roleTools } = await import(protocolUrl)

/**
 * Fixture: a project whose .env must stay unreachable through search_content,
 * a nested source file that must be findable, build dirs that must never
 * appear, and a readable file that repeats a secret value (proving redact()).
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'search-content-'))
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })

  writeFileSync(
    join(dir, '.env'),
    'ENV_ONLY_SECRET=envonlyvalue123456\nAPI_KEY=redactablesecret123456\n',
  )
  writeFileSync(
    join(dir, 'src', 'nested', 'deep.ts'),
    'export function locateWidgetFactory() {\n  const marker = 1\n  return marker\n}\n',
  )
  writeFileSync(join(dir, 'src', 'nested', 'sibling.ts'), 'export const plainHelper = () => 42\n')
  writeFileSync(
    join(dir, 'notes.txt'),
    'api key is redactablesecret123456 in dev\na+b(c) is literal text here\n',
  )
  writeFileSync(join(dir, 'dist', 'bundle.js'), 'const DIST_MARKER_7f3a = 1\n')
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'const NODE_MODULES_MARKER_9d2b = 1\n')
  writeFileSync(
    join(dir, 'many.txt'),
    Array.from({ length: 20 }, (_, i) => `hit-${i}`).join('\n') + '\n',
  )

  const handle = createToolHandle(dir)
  return { dir, handle }
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('search_content finds a symbol in a nested source file', async () => {
  const { dir, handle } = fixture()
  try {
    const result = await handle.callTool('search_content', { query: 'locateWidgetFactory' })
    assert.equal(typeof result, 'string')
    assert.match(result, /src\/nested\/deep\.ts:1:/)
    assert.match(result, /locateWidgetFactory/)
    assert.ok(!result.includes('No matches found'))
  } finally {
    cleanup(dir)
  }
})

test('search_content never surfaces .env contents (P3)', async () => {
  const { dir, handle } = fixture()
  try {
    // The key name lives only in .env.
    const byName = await handle.callTool('search_content', { query: 'ENV_ONLY_SECRET' })
    assert.equal(byName, 'No matches found.')

    // The value lives only in .env.
    const byValue = await handle.callTool('search_content', { query: 'envonlyvalue123456' })
    assert.equal(byValue, 'No matches found.')

    // The value also appears in a readable file, but redact() masks it there —
    // so the secret is unreachable even via a non-masked path.
    const bySharedValue = await handle.callTool('search_content', { query: 'redactablesecret123456' })
    assert.equal(bySharedValue, 'No matches found.')

    // Regex form of the same probe.
    const byRegex = await handle.callTool('search_content', {
      query: 'ENV_ONLY|envonlyvalue',
      isRegex: true,
    })
    assert.equal(byRegex, 'No matches found.')

    // Match-everything sweep: every readable file is returned, .env is not.
    const sweep = await handle.callTool('search_content', { query: '.', isRegex: true, maxResults: 200 })
    assert.equal(typeof sweep, 'string')
    assert.ok(!sweep.includes('.env'), `.env surfaced in sweep: ${sweep}`)
    assert.ok(!sweep.includes('envonlyvalue'), `env secret surfaced in sweep: ${sweep}`)
    assert.ok(!sweep.includes('ENV_ONLY_SECRET'), `.env key surfaced in sweep: ${sweep}`)
    assert.match(sweep, /src\/nested\/deep\.ts/)
  } finally {
    cleanup(dir)
  }
})

test('search_content redacts every returned line', async () => {
  const { dir, handle } = fixture()
  try {
    const result = await handle.callTool('search_content', { query: 'api key is' })
    assert.match(result, /notes\.txt:1:/)
    assert.match(result, /\[REDACTED:API_KEY\]/)
    assert.ok(!result.includes('redactablesecret123456'), `secret leaked: ${result}`)
  } finally {
    cleanup(dir)
  }
})

test('search_content honours SKIP_DIRS (dist/ and node_modules/ never appear)', async () => {
  const { dir, handle } = fixture()
  try {
    const dist = await handle.callTool('search_content', { query: 'DIST_MARKER_7f3a' })
    assert.equal(dist, 'No matches found.')

    const modules = await handle.callTool('search_content', { query: 'NODE_MODULES_MARKER_9d2b' })
    assert.equal(modules, 'No matches found.')

    const sweep = await handle.callTool('search_content', { query: 'MARKER', isRegex: true })
    assert.equal(sweep, 'No matches found.')
  } finally {
    cleanup(dir)
  }
})

test('search_content treats the query as literal unless isRegex is set', async () => {
  const { dir, handle } = fixture()
  try {
    const literal = await handle.callTool('search_content', { query: 'a+b(c)' })
    assert.match(literal, /notes\.txt:2:/)

    const regex = await handle.callTool('search_content', {
      query: 'Widget(Factory)?',
      isRegex: true,
    })
    assert.match(regex, /src\/nested\/deep\.ts:1:/)

    const invalid = await handle.callTool('search_content', { query: '(', isRegex: true })
    assert.match(invalid, /invalid regular expression/)
  } finally {
    cleanup(dir)
  }
})

test('search_content caps results at maxResults', async () => {
  const { dir, handle } = fixture()
  try {
    const result = await handle.callTool('search_content', { query: 'hit-', maxResults: 3 })
    const lines = result.trim().split('\n')
    assert.equal(lines.length, 4) // 3 matches + cap notice
    assert.match(lines[0], /many\.txt:1: hit-0/)
    assert.match(lines[1], /many\.txt:2: hit-1/)
    assert.match(lines[2], /many\.txt:3: hit-2/)
    assert.match(lines[3], /capped at 3 results/)
  } finally {
    cleanup(dir)
  }
})

test('search_files previews are redacted too', async () => {
  const { dir, handle } = fixture()
  try {
    const result = await handle.callTool('search_files', { query: 'api key notes' })
    assert.equal(typeof result, 'string')
    assert.ok(!result.includes('redactablesecret123456'), `secret leaked in preview: ${result}`)
    assert.ok(!result.includes('.env'), `.env surfaced in search_files: ${result}`)
  } finally {
    cleanup(dir)
  }
})

test('search_content and run_baseline are exposed to the right roles (P3/P6)', () => {
  assert.ok(roleTools.developer.includes('search_content'))
  assert.ok(roleTools.worker.includes('search_content'))
  assert.ok(roleTools.developer.includes('run_baseline'))
  assert.ok(!roleTools.worker.includes('run_baseline'))
})
