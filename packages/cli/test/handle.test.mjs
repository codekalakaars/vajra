import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const handleUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tools', 'handle.js')).href
const { tokenizeCommand, createToolHandle } = await import(handleUrl)

test('tokenizeCommand rejects shell metacharacters', () => {
  const result = tokenizeCommand('echo a && rm -rf /')
  assert.equal(result.ok, false)
  assert.match(result.error, /metacharacter/)

  assert.equal(tokenizeCommand('echo hi > out.txt').ok, false)
  assert.equal(tokenizeCommand('ls; ls').ok, false)
  assert.equal(tokenizeCommand('`whoami`').ok, false)
  assert.equal(tokenizeCommand('$(id)').ok, false)
})

test('tokenizeCommand respects quotes and produces argv', () => {
  const result = tokenizeCommand('git commit -m "fix: update docs"')
  assert.equal(result.ok, true)
  assert.deepEqual(result.argv, ['git', 'commit', '-m', 'fix: update docs'])
})

test('tokenizeCommand rejects unclosed quotes and empty input', () => {
  assert.equal(tokenizeCommand('echo "unclosed').ok, false)
  assert.equal(tokenizeCommand('   ').ok, false)
})

test('read_file returns a redacted stub for .env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-'))
  try {
    writeFileSync(join(dir, '.env'), 'SECRET_KEY=supersecret\n')
    const handle = createToolHandle(dir)
    const result = await handle.callTool('read_file', { path: join(dir, '.env') })
    assert.equal(typeof result, 'string')
    assert.match(result, /REDACTED/)
    assert.ok(!result.includes('supersecret'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read_file returns a redacted stub for environment-specific env files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-env-'))
  try {
    writeFileSync(join(dir, '.env.production'), 'PRODUCTION_SECRET=prodsecret\n')
    const handle = createToolHandle(dir)
    const result = await handle.callTool('read_file', { path: join(dir, '.env.production') })
    assert.equal(typeof result, 'string')
    assert.match(result, /REDACTED/)
    assert.ok(!result.includes('prodsecret'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run_command returns C1 JSON shape and rejects cwd escape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-cwd-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const handle = createToolHandle(dir)

    const escape = await handle.callTool('run_command', { command: 'node', cwd: '../..' })
    assert.equal(typeof escape, 'string')
    const escapeParsed = JSON.parse(escape)
    assert.equal(typeof escapeParsed.exitCode, 'number')
    assert.ok(escapeParsed.exitCode !== 0)
    assert.match(escapeParsed.stderr, /escapes/)

    const ok = await handle.callTool('run_command', {
      command: 'node -e "process.stdout.write(\'1\')"',
      cwd: 'src',
    })
    const okParsed = JSON.parse(ok)
    assert.equal(okParsed.exitCode, 0)
    assert.equal(okParsed.signal, null)
    assert.equal(okParsed.stdout, '1')

    const bad = await handle.callTool('run_command', { command: 'node -e "0" && node -e "1"' })
    const badParsed = JSON.parse(bad)
    assert.ok(badParsed.exitCode !== 0)
    assert.match(badParsed.stderr, /metacharacter/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run_command rejects unknown commands and reports failure on non-zero exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-cmd-'))
  try {
    const handle = createToolHandle(dir)

    const denied = await handle.callTool('run_command', { command: 'not-a-real-tool' })
    const deniedParsed = JSON.parse(denied)
    assert.ok(deniedParsed.exitCode !== 0)
    assert.match(deniedParsed.stderr, /not allowed/)

    const fail = await handle.callTool('run_command', { command: 'node -e "process.exit(3)"' })
    const failParsed = JSON.parse(fail)
    assert.equal(failParsed.exitCode, 3)
    assert.equal(failParsed.signal, null)
    assert.equal(typeof failParsed.stdout, 'string')
    assert.equal(typeof failParsed.stderr, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run_baseline returns the same C1 shape and appends argv args', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-baseline-'))
  try {
    const handle = createToolHandle(dir)

    const pass = await handle.callTool('run_baseline', {
      command: 'node',
      args: ['-e', 'process.exit(0)'],
    })
    const passParsed = JSON.parse(pass)
    assert.equal(passParsed.exitCode, 0)
    assert.equal(passParsed.signal, null)

    const fail = await handle.callTool('run_baseline', {
      command: 'node -e "process.exit(7)"',
      args: [],
    })
    const failParsed = JSON.parse(fail)
    assert.equal(failParsed.exitCode, 7)

    const denied = await handle.callTool('run_baseline', { command: 'not-a-real-tool', args: [] })
    const deniedParsed = JSON.parse(denied)
    assert.ok(deniedParsed.exitCode !== 0)
    assert.match(deniedParsed.stderr, /not allowed/)

    const escape = await handle.callTool('run_baseline', { command: 'node', args: [], cwd: '../..' })
    const escapeParsed = JSON.parse(escape)
    assert.match(escapeParsed.stderr, /escapes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task permissions deny writes outside the allow-list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-perm-'))
  try {
    writeFileSync(join(dir, 'allowed.txt'), 'a')
    writeFileSync(join(dir, 'denied.txt'), 'd')
    let mutated = 0
    const handle = createToolHandle(dir, {
      permissions: path =>
        path.endsWith('allowed.txt')
          ? { read: true, write: true, edit: true, delete: false }
          : { read: false, write: false, edit: false, delete: false },
      onMutate: () => {
        mutated++
      },
    })

    await assert.rejects(
      () => handle.callTool('write_file', { path: join(dir, 'denied.txt'), content: 'x' }),
      /Access denied/,
    )

    const ok = await handle.callTool('write_file', { path: join(dir, 'allowed.txt'), content: 'ok' })
    assert.equal(ok, 'ok')
    assert.equal(mutated, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
