import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { tokenizeCommand, createToolHandle } from '../dist/index.js'

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

test('internal argv preserves argument boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-argv-'))
  try {
    const handle = createToolHandle(dir)
    const result = JSON.parse(await handle.callTool('run_command', {
      command: 'ignored',
      argv: ['node', '-e', 'process.stdout.write("a b")'],
    }))
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'a b')
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

// --- write_stub / delete_stub ------------------------------------------------
//
// The Developer's only write surface. The guarantees are checked here rather
// than trusted from the prompt, because a model that ignores an instruction is
// expected and a tool that permits the write is not.

test('write_stub creates a new file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-stub-'))
  try {
    const handle = createToolHandle(dir, { stubs: new Set() })
    const result = await handle.callTool('write_stub', {
      path: 'src/auth.ts',
      content: 'export const auth = () => {}\n',
    })
    assert.match(result, /Created src\/auth\.ts/)
    assert.equal(readFileSync(join(dir, 'src', 'auth.ts'), 'utf-8'), 'export const auth = () => {}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write_stub refuses to touch a file that already exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-stub-'))
  try {
    writeFileSync(join(dir, 'existing.ts'), 'original\n')
    const handle = createToolHandle(dir, { stubs: new Set() })

    await assert.rejects(
      () => handle.callTool('write_stub', { path: 'existing.ts', content: 'replaced' }),
      /already exists/,
    )
    // The point is not just the error: the file is untouched.
    assert.equal(readFileSync(join(dir, 'existing.ts'), 'utf-8'), 'original\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write_stub refuses a path outside the project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-stub-'))
  try {
    const handle = createToolHandle(dir, { stubs: new Set() })
    for (const path of ['../escape.ts', '/etc/passwd-stub', '.']) {
      await assert.rejects(
        () => handle.callTool('write_stub', { path, content: 'x' }),
        /outside project directory/,
        `"${path}" must not be writable`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write_stub refuses a masked file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-stub-'))
  try {
    const handle = createToolHandle(dir, { stubs: new Set() })
    await assert.rejects(
      () => handle.callTool('write_stub', { path: '.env', content: 'SECRET=1' }),
      /masked file/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete_stub removes only what write_stub created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-stub-'))
  try {
    writeFileSync(join(dir, 'pre-existing.ts'), 'keep me\n')
    const stubs = new Set()
    const handle = createToolHandle(dir, { stubs })

    await handle.callTool('write_stub', { path: 'mine.ts', content: 'mine\n' })
    assert.ok(existsSync(join(dir, 'mine.ts')))

    // Existing code is not retractable, however it is spelled.
    for (const path of ['pre-existing.ts', join(dir, 'pre-existing.ts'), './pre-existing.ts']) {
      await assert.rejects(
        () => handle.callTool('delete_stub', { path }),
        /not created by write_stub/,
        `"${path}" must not be deletable`,
      )
    }
    assert.equal(readFileSync(join(dir, 'pre-existing.ts'), 'utf-8'), 'keep me\n')

    // Its own stub, in any equivalent spelling, is.
    const result = await handle.callTool('delete_stub', { path: './mine.ts' })
    assert.match(result, /Deleted \.\/mine\.ts/)
    assert.ok(!existsSync(join(dir, 'mine.ts')))

    // And only once: a second delete is refused, so the registry really emptied.
    await assert.rejects(() => handle.callTool('delete_stub', { path: 'mine.ts' }), /not created/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a registry-less handle says it cannot prove a file is scaffolding', async () => {
  // This test used to assert the opposite, and the bug it pinned was real: the
  // sandbox worker's handle was built without a `stubs` set, so `write_stub`
  // wrote the file and recorded nothing while `delete_stub` reported it was
  // "not created by write_stub in this session". Read out of a real session:
  // four Phase One files written, the project's test suite broken by them, four
  // deletion attempts refused, and the Developer had to ask the human to clean
  // up after itself. A missing registry is a wiring fault and now says so —
  // the old message was a false statement about the file.
  const dir = mkdtempSync(join(tmpdir(), 'handle-stub-noreg-'))
  try {
    const handle = createToolHandle(dir)
    const written = await handle.callTool('write_stub', { path: 'src/scaffold.ts', content: 'export {}\n' })
    assert.match(written, /Created src\/scaffold\.ts/)
    await assert.rejects(
      () => handle.callTool('delete_stub', { path: 'src/scaffold.ts' }),
      /no stub registry/,
      'the refusal must name the wiring fault, not claim the file was never created',
    )
    assert.equal(readFileSync(join(dir, 'src', 'scaffold.ts'), 'utf-8'), 'export {}\n', 'and change nothing')
    // A handle that does have a registry still refuses a foreign file on its
    // merits — the wiring message replaced one lie with the truth, it did not
    // replace a check.
    const withRegistry = createToolHandle(dir, { stubs: new Set() })
    await assert.rejects(
      () => withRegistry.callTool('delete_stub', { path: 'anything.ts' }),
      /not created by write_stub/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- read_file narrowing -----------------------------------------------------

const TS_FIXTURE = [
  'export type Todo = { id: string; text: string }',
  '',
  'export const initialTodos: Todo[] = []',
  '',
  'export function addTodo(t: Todo) {',
  '  return [...initialTodos, t]',
  '}',
  '',
  'export function removeTodo(id: string) {',
  '  return initialTodos.filter(t => t.id !== id)',
  '}',
  '',
].join('\n')

test('read_file with no window returns the whole file, byte for byte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-read-'))
  try {
    writeFileSync(join(dir, 'todo.ts'), TS_FIXTURE)
    const handle = createToolHandle(dir)
    const full = await handle.callTool('read_file', { path: join(dir, 'todo.ts') })
    assert.equal(full, TS_FIXTURE, 'the default read is unchanged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read_file can return a line window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-read-'))
  try {
    writeFileSync(join(dir, 'todo.ts'), TS_FIXTURE)
    const handle = createToolHandle(dir)
    const window = await handle.callTool('read_file', { path: 'todo.ts', offset: 5, limit: 3 })

    assert.match(window, /lines 5-7 of 12/, 'the window is stated')
    assert.match(window, /export function addTodo/)
    assert.match(window, /return \[\.\.\.initialTodos, t\]/)
    assert.doesNotMatch(window, /export function removeTodo/, 'and the rest is not shown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read_file can return named symbols', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-read-'))
  try {
    writeFileSync(join(dir, 'todo.ts'), TS_FIXTURE)
    const handle = createToolHandle(dir)
    const window = await handle.callTool('read_file', { path: 'todo.ts', symbols: ['addTodo'] })

    assert.match(window, /1 symbol/)
    assert.match(window, /export function addTodo/)
    assert.match(window, /return \[\.\.\.initialTodos, t\]/)
    assert.doesNotMatch(window, /removeTodo/, 'an unrequested symbol is not shown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read_file reports a symbol it cannot find instead of returning nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-read-'))
  try {
    writeFileSync(join(dir, 'todo.ts'), TS_FIXTURE)
    const handle = createToolHandle(dir)
    const window = await handle.callTool('read_file', { path: 'todo.ts', symbols: ['nopeNotHere'] })

    // An empty window would read as "this file is empty" and the model would
    // plan against a fiction, so the full file comes back with an explanation.
    assert.match(window, /no declaration found for nopeNotHere/)
    assert.match(window, /export function addTodo/, 'the file is still there')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a windowed read narrows the evidence, so an anchor outside it is refused', async () => {
  // This is the safety property. The plan validator checks anchors against
  // whatever read_file returned, so a window that hid the rest of the file must
  // also stop an anchor being accepted against text the model never saw.
  const dir = mkdtempSync(join(tmpdir(), 'handle-read-'))
  try {
    writeFileSync(join(dir, 'todo.ts'), TS_FIXTURE)
    const handle = createToolHandle(dir)
    const window = await handle.callTool('read_file', { path: 'todo.ts', offset: 5, limit: 3 })
    assert.doesNotMatch(window, /initialTodos\.filter/, 'the anchor target is outside the window')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a windowed read does not poison the cache for a later full read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handle-read-'))
  try {
    writeFileSync(join(dir, 'todo.ts'), TS_FIXTURE)
    const handle = createToolHandle(dir)
    await handle.callTool('read_file', { path: 'todo.ts', offset: 5, limit: 3 })
    const full = await handle.callTool('read_file', { path: 'todo.ts' })
    assert.equal(full, TS_FIXTURE, 'the full read is still complete')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
