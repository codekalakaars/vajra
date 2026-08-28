// End-to-end checks against the built addon.
//
// These exist because the Rust unit tests cannot see the Node boundary: the
// bugs they catch (a struct exported as a JS class instead of a plain object,
// a loader pointing at the wrong filename) are invisible to `cargo test` and
// only surface when JavaScript actually requires the binding.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('../index.js')

const isWindows = process.platform === 'win32'

// The shell and a sleep differ per platform; the behaviour under test does not.
const SHELL = isWindows ? 'cmd' : 'sh'
const sleepCmd = (seconds) =>
  isWindows ? `powershell -Command "Start-Sleep -Milliseconds ${seconds * 1000}"` : `sleep ${seconds}`

function scratch() {
  return mkdtempSync(join(tmpdir(), 'vajra-smoke-'))
}

/** Creating a symlink on Windows needs privileges CI may not have. */
function trySymlink(target, linkPath) {
  try {
    symlinkSync(target, linkPath, 'dir')
    return true
  } catch {
    return false
  }
}

test('addon loads and reports its version', () => {
  assert.match(native.version(), /^\d+\.\d+\.\d+$/)
})

test('file round-trip', () => {
  const dir = scratch()
  const file = join(dir, 'a.txt')

  native.writeFile(file, 'hello')
  assert.equal(native.readFile(file), 'hello')
  assert.equal(native.fileExists(file), true)
  assert.equal(native.isFile(file), true)
  assert.equal(native.isDir(file), false)
  assert.equal(native.fileSize(file), 5)

  rmSync(dir, { recursive: true, force: true })
})

test('editFile refuses an ambiguous match and leaves the file intact', () => {
  const dir = scratch()
  const file = join(dir, 'a.txt')
  writeFileSync(file, 'x x')

  assert.throws(() => native.editFile(file, 'x', 'y'), /occurs 2 times/)
  assert.equal(readFileSync(file, 'utf8'), 'x x')

  assert.equal(native.editFile(file, 'x', 'y', true), 2)
  assert.equal(readFileSync(file, 'utf8'), 'y y')

  rmSync(dir, { recursive: true, force: true })
})

test('deleteFile will not silently destroy a directory tree', () => {
  const dir = scratch()
  const nested = join(dir, 'nested')
  mkdirSync(nested)
  writeFileSync(join(nested, 'keep.txt'), 'important')

  assert.throws(() => native.deleteFile(nested), /use deleteDir/)
  assert.equal(native.fileExists(join(nested, 'keep.txt')), true)

  assert.throws(() => native.deleteDir(nested), /Failed to delete/)
  native.deleteDir(nested, true)
  assert.equal(native.fileExists(nested), false)

  rmSync(dir, { recursive: true, force: true })
})

test('listFiles returns plain objects, not class instances', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'a.txt'), 'x')

  const entries = native.listFiles(dir)
  assert.equal(entries.length, 1)

  const [entry] = entries
  // A #[napi] struct would arrive as a class instance whose fields are not own
  // enumerable properties; #[napi(object)] gives a real plain object.
  assert.equal(Object.getPrototypeOf(entry), Object.prototype)
  assert.deepEqual(Object.keys(entry).sort(), ['isDir', 'isFile', 'isSymlink', 'name', 'path', 'size'])
  assert.equal(entry.name, 'a.txt')

  rmSync(dir, { recursive: true, force: true })
})

test('listFiles does not follow symlink cycles', (t) => {
  const dir = scratch()
  const sub = join(dir, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'f.txt'), 'x')

  if (!trySymlink(dir, join(sub, 'loop'))) {
    rmSync(dir, { recursive: true, force: true })
    t.skip('symlink creation not permitted on this host')
    return
  }

  // The previous implementation recursed through this link until it overflowed.
  const entries = native.listFiles(dir, true)
  assert.ok(entries.some((e) => e.name === 'f.txt'))
  assert.equal(entries.find((e) => e.name === 'loop').isSymlink, true)

  rmSync(dir, { recursive: true, force: true })
})

test('path helpers normalize without touching the filesystem', () => {
  // Separators are platform-native, so compare against a joined expectation
  // rather than a hardcoded POSIX string. None of these paths exist.
  assert.equal(native.normalizePath(join('a', 'b', '..', 'c')), join('a', 'c'))
  assert.equal(native.normalizePath(join('a', '..', '..', 'b')), join('..', 'b'))
  assert.equal(native.joinPaths(join('a', 'b'), join('..', 'c')), join('a', 'c'))
  assert.equal(native.basename(join('a', 'b.txt'), '.txt'), 'b')
  assert.equal(native.ensureExt('a', 'json'), 'a.json')
  assert.ok(native.isAbsolute(native.resolvePath(join('a', '..', 'b'))))
})

test('process helpers run commands and locate executables', () => {
  // `echo` is a cmd builtin on Windows, not a program, so go through the shell.
  const result = isWindows
    ? native.runCommand('cmd', ['/C', 'echo hi'])
    : native.runCommand('echo', ['hi'])

  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /hi/)

  assert.equal(native.runShell('exit 3').code, 3)

  const shell = native.which(SHELL)
  assert.ok(native.isAbsolute(shell))
  // `where` on Windows prints one line per match; the result must be one path.
  assert.ok(!shell.includes('\n'))
  assert.equal(native.which('vajra-no-such-program'), null)
})

test('env helpers read the environment', () => {
  assert.equal(native.envExists('PATH'), true)
  assert.ok(native.getEnv('PATH').length > 0)
  assert.equal(native.getEnv('VAJRA_DEFINITELY_NOT_SET'), null)

  const filtered = native.getEnvFiltered('PATH')
  assert.ok(filtered.every((v) => v.key.startsWith('PATH')))
  assert.equal(Object.getPrototypeOf(filtered[0]), Object.prototype)

  assert.ok(native.tempDir().length > 0)
})

test('async file helpers round-trip off the event loop', async () => {
  const dir = scratch()
  const file = join(dir, 'a.txt')

  await native.writeFileAsync(file, 'hello')
  assert.equal(await native.readFileAsync(file), 'hello')

  const entries = await native.listFilesAsync(dir, true)
  assert.ok(entries.some((e) => e.name === 'a.txt'))
  assert.equal(Object.getPrototypeOf(entries[0]), Object.prototype)

  rmSync(dir, { recursive: true, force: true })
})

test('runShellAsync does not block the event loop', async () => {
  // The sync version holds the loop for the child's whole lifetime. If the async
  // one did too, no timer could fire while the sleep is in flight.
  let ticked = false
  const timer = setInterval(() => {
    ticked = true
  }, 10)

  const result = await native.runShellAsync(sleepCmd(0.3))
  clearInterval(timer)

  assert.equal(result.code, 0)
  assert.equal(ticked, true, 'event loop was blocked during the async call')
})

test('runCommandAsync reports failures as rejections', async () => {
  const ok = isWindows
    ? await native.runCommandAsync('cmd', ['/C', 'echo hi'])
    : await native.runCommandAsync('echo', ['hi'])

  assert.match(ok.stdout, /hi/)
  await assert.rejects(() => native.runCommandAsync('vajra-no-such-program'))
})

test('mutating env bindings are deliberately absent', () => {
  // set_var/remove_var are not thread-safe and Node runs worker threads.
  assert.equal(native.setEnv, undefined)
  assert.equal(native.removeEnv, undefined)
})
