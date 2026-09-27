import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const altUrl = pathToFileURL(
  join(import.meta.dirname, '..', 'dist', 'tui', 'session', 'alt-screen.js'),
).href
const { enterAltScreen, exitAltScreen, __resetAltScreenForTests } = await import(altUrl)

const ENTER = '\x1b[?1049h\x1b[H'
const LEAVE = '\x1b[?1049l'

function captureStdout(fn) {
  const chunks = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    fn()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join('')
}

test('enter and leave bracket the session with the alt-screen sequences', () => {
  __resetAltScreenForTests()
  const out = captureStdout(() => {
    enterAltScreen()
    enterAltScreen() // re-entrant: must not double-switch the buffer
    exitAltScreen()
    exitAltScreen() // already restored: no second switch back
  })
  assert.equal(out, ENTER + LEAVE, 'exactly one switch in and one switch out')
})

test('the normal buffer is restored even on a hard process.exit', async () => {
  // The alt-screen module installs a synchronous `exit` hook: an Ink session
  // force-quit with process.exit() must never strand the user in the alt
  // buffer (no mouse reporting, no scrollback, a terminal that looks broken).
  const script = `
    const { enterAltScreen } = await import(${JSON.stringify(altUrl)})
    enterAltScreen()
    process.stdout.write('BODY')
    setTimeout(() => process.exit(0), 100)
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script])
  assert.ok(stdout.includes(ENTER), 'session entered the alt buffer')
  assert.ok(stdout.includes('BODY'), 'the session body was written')
  assert.ok(stdout.endsWith(LEAVE), `leave sequence must come last, got: ${JSON.stringify(stdout)}`)
})

test('fatal signals restore the buffer before the process dies', async () => {
  // Node skips the `exit` event when killed by a signal, so alt-screen.ts
  // installs its own handlers: without them the next shell prompt lands in
  // the alt buffer (no scrollback, no mouse) until someone runs `reset`.
  const script = `
    const { enterAltScreen } = await import(${JSON.stringify(altUrl)})
    enterAltScreen()
    process.stdout.write('BODY')
    setInterval(() => {}, 1000)
  `
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const result = await new Promise(res => {
      const child = execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        (err, stdout) => res({ err, stdout }),
      )
      setTimeout(() => child.kill(signal), 300)
    })
    assert.equal(result.err?.code, code, `${signal} must exit with 128+signo`)
    assert.ok(
      result.stdout.endsWith(LEAVE),
      `${signal} must restore the normal buffer, got: ${JSON.stringify(result.stdout)}`,
    )
  }
})
