import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)))
const { createToolHandle } = await import(
  pathToFileURL(join(cliDir, 'dist', 'tools', 'handle.js')).href
)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-readcache-'))
  return {
    dir,
    file: join(dir, 'notes.txt'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// Integer-second timestamps: mtimeMs = T * 1000 is exactly representable in
// float64, so set-then-restore round-trips through statSync identically.
function setMtime(path, T) {
  utimesSync(path, T, T)
}

const T0 = Math.floor(Date.now() / 1000) - 1000

test('cache hit: same path + mtime serves the stored value without re-reading', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'version A')
  setMtime(f.file, T0)
  const h = createToolHandle(f.dir)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'version A')
  // Change the content but restore the mtime: only a cache hit explains
  // returning the stale value. A fresh read would return 'version B'.
  writeFileSync(f.file, 'version B')
  setMtime(f.file, T0)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'version A')
})

test('mtime change: a modified file is re-read', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'version A')
  setMtime(f.file, T0)
  const h = createToolHandle(f.dir)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'version A')
  writeFileSync(f.file, 'version B')
  setMtime(f.file, T0 + 10)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'version B')
})

test('write_file invalidates its path even if mtime is restored', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'version A')
  setMtime(f.file, T0)
  const h = createToolHandle(f.dir)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'version A')
  await h.callTool('write_file', { path: f.file, content: 'version C' })
  setMtime(f.file, T0)
  // Without explicit invalidation the entry {T0, 'version A'} would still hit.
  assert.equal(await h.callTool('read_file', { path: f.file }), 'version C')
})

test('edit_file invalidates its path', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'alpha beta')
  setMtime(f.file, T0)
  const h = createToolHandle(f.dir)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'alpha beta')
  await h.callTool('edit_file', { path: f.file, oldString: 'beta', newString: 'gamma' })
  setMtime(f.file, T0)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'alpha gamma')
})

test('delete_file drops the entry: subsequent read fails', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'doomed')
  const h = createToolHandle(f.dir)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'doomed')
  await h.callTool('delete_file', { path: f.file })
  await assert.rejects(() => h.callTool('read_file', { path: f.file }))
})

test('external change (run_command) is picked up on the next read', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'version A')
  setMtime(f.file, T0)
  const h = createToolHandle(f.dir)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'version A')
  const res = JSON.parse(
    await h.callTool('run_command', {
      command: `node -e "require('node:fs').writeFileSync(process.argv[1], 'version D')" ${f.file}`,
    }),
  )
  assert.equal(res.exitCode, 0)
  setMtime(f.file, T0)
  assert.equal(await h.callTool('read_file', { path: f.file }), 'version D')
})

test('shared fallback handles invalidate one another after commands', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'version A')
  setMtime(f.file, T0)
  const cache = { read: new Map(), generation: 0 }
  const first = createToolHandle(f.dir, { cache })
  const second = createToolHandle(f.dir, { cache })
  assert.equal(await first.callTool('read_file', { path: f.file }), 'version A')
  const result = JSON.parse(await second.callTool('run_command', {
    command: `node -e "require('node:fs').writeFileSync(process.argv[1], 'version B')" ${f.file}`,
  }))
  assert.equal(result.exitCode, 0)
  setMtime(f.file, T0)
  assert.equal(await first.callTool('read_file', { path: f.file }), 'version B')
})

test('masked files: always the stub, content never cached', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const env = join(f.dir, '.env')
  writeFileSync(env, 'API_KEY=redactablesecret123456\n')
  const h = createToolHandle(f.dir)
  const first = await h.callTool('read_file', { path: env })
  const second = await h.callTool('read_file', { path: env })
  assert.equal(first, '[REDACTED: masked file — contents withheld]')
  assert.equal(second, first)
  assert.ok(!first.includes('redactablesecret123456'))
  assert.ok(!second.includes('redactablesecret123456'))
  // A file repeating the .env secret is redacted on every read, hit or miss.
  const notes = join(f.dir, 'notes.txt')
  writeFileSync(notes, 'api key is redactablesecret123456 in dev\n')
  assert.equal(
    await h.callTool('read_file', { path: notes }),
    'api key is [REDACTED:API_KEY] in dev\n',
  )
  assert.equal(
    await h.callTool('read_file', { path: notes }),
    'api key is [REDACTED:API_KEY] in dev\n',
  )
})

test('permission gate runs on every read, including cache hits', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'sensitive')
  let allow = true
  const h = createToolHandle(f.dir, {
    permissions: () => ({ read: allow, write: allow, edit: allow, delete: allow }),
  })
  assert.equal(await h.callTool('read_file', { path: f.file }), 'sensitive')
  allow = false
  await assert.rejects(
    () => h.callTool('read_file', { path: f.file }),
    /Access denied/,
  )
})

test('relative and absolute spellings share one cache entry', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(f.file, 'version A')
  setMtime(f.file, T0)
  const h = createToolHandle(f.dir)
  const { relative } = await import('node:path')
  const rel = relative(process.cwd(), f.file)
  await h.callTool('read_file', { path: rel })
  // Same key → invalidation through the relative spelling clears the absolute one.
  await h.callTool('write_file', { path: f.file, content: 'version B' })
  assert.equal(await h.callTool('read_file', { path: rel }), 'version B')
})
