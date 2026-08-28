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

function scratch() {
  return mkdtempSync(join(tmpdir(), 'vajra-smoke-'))
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

test('listFiles does not follow symlink cycles', () => {
  const dir = scratch()
  const sub = join(dir, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'f.txt'), 'x')
  symlinkSync(dir, join(sub, 'loop'))

  // The previous implementation recursed through this link until it overflowed.
  const entries = native.listFiles(dir, true)
  assert.ok(entries.some((e) => e.name === 'f.txt'))
  assert.equal(entries.find((e) => e.name === 'loop').isSymlink, true)

  rmSync(dir, { recursive: true, force: true })
})

test('path helpers normalize without touching the filesystem', () => {
  // None of these paths exist.
  assert.equal(native.normalizePath('/a/b/../c'), '/a/c')
  assert.equal(native.normalizePath('a/../../b'), '../b')
  assert.equal(native.joinPaths('/a/b', '../c'), '/a/c')
  assert.equal(native.basename('/a/b.txt', '.txt'), 'b')
  assert.equal(native.ensureExt('a', 'json'), 'a.json')
  assert.ok(native.isAbsolute(native.resolvePath('a/../b')))
})

test('process helpers run commands and locate executables', () => {
  const result = native.runCommand('echo', ['hi'])
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /hi/)

  assert.equal(native.runShell('exit 3').code, 3)

  const sh = native.which('sh')
  assert.ok(sh.startsWith('/'))
  assert.ok(!sh.includes('\n'))
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

test('mutating env bindings are deliberately absent', () => {
  // set_var/remove_var are not thread-safe and Node runs worker threads.
  assert.equal(native.setEnv, undefined)
  assert.equal(native.removeEnv, undefined)
})
