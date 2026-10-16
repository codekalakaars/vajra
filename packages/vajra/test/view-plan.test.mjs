import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { planView, ViewPolicyError } = await import(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'view', 'plan.js')).href)

/** A project on disk: folders end in /, anything else is a file. */
function project(t, entries) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-view-test-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const entry of entries) {
    if (entry.endsWith('/')) mkdirSync(join(root, entry), { recursive: true })
    else {
      mkdirSync(dirname(join(root, entry)), { recursive: true })
      writeFileSync(join(root, entry), 'x\n')
    }
  }
  return root
}

const rights = (read, write = false, del = false) => ({ read, write, edit: write, delete: del })
const config = files => ({ version: 1, default: rights(true), files })

test('no rules means no mounts: the read-only base view is all there is', (t) => {
  const root = project(t, ['a.txt', 'src/'])
  const plan = planView(root, config({}))
  assert.deepEqual(plan, { args: [], hidden: [], writable: [], creatable: [] })
})

test('a hidden file makes its folder an empty read-only filesystem with every other name bound back', (t) => {
  const root = project(t, ['keep.txt', 'secret.txt', 'src/'])
  const { args, hidden } = planView(root, config({ 'secret.txt': rights(false) }))
  assert.deepEqual(hidden, ['secret.txt'])
  assert.deepEqual(args.slice(0, 2), ['--tmpfs', root])
  assert.ok(args.includes(join(root, 'keep.txt')))
  assert.ok(args.includes(join(root, 'src')))
  assert.ok(!args.includes(join(root, 'secret.txt')), 'the hidden name is never bound')
  assert.deepEqual(args.slice(-2), ['--remount-ro', root], 'and the rebuilt folder cannot take new files')
})

test('only the folder that holds the hidden name is rebuilt', (t) => {
  const root = project(t, ['top.txt', 'docs/guide.md', 'docs/private.md'])
  const { args } = planView(root, config({ 'docs/private.md': rights(false) }))
  assert.ok(args.includes(join(root, 'docs')), 'docs is rebuilt')
  assert.ok(!args.includes(root), 'the project root is left alone')
  assert.ok(args.includes(join(root, 'docs', 'guide.md')))
})

test('a hidden folder disappears whole', (t) => {
  const root = project(t, ['secrets/key', 'src/a.ts'])
  const { args, hidden } = planView(root, config({ 'secrets/': rights(false) }))
  assert.deepEqual(hidden, ['secrets'])
  assert.ok(!args.some(a => a.includes('secrets')) || args[1] === root, 'nothing is bound from inside it')
  assert.ok(!args.includes(join(root, 'secrets')))
})

test('a write or delete rule is bound read-write', (t) => {
  const root = project(t, ['src/a.ts', 'notes.md', 'old/'])
  const { args, writable } = planView(root, config({ 'src/': rights(true, true), 'notes.md': rights(true, true), 'old/': rights(true, false, true) }))
  assert.deepEqual(writable, ['notes.md', 'old', 'src'])
  for (const name of ['src', 'notes.md', 'old']) {
    const at = args.findIndex((arg, i) => arg === '--bind' && args[i + 1] === join(root, name))
    assert.ok(at >= 0, `${name} is bound read-write`)
  }
})

test('a hidden name inside a writable folder is refused, not loosened', (t) => {
  const root = project(t, ['src/a.ts', 'src/token'])
  assert.throws(
    () => planView(root, config({ 'src/': rights(true, true), 'src/token': rights(false) })),
    err => err instanceof ViewPolicyError && /cannot be hidden inside "src\/"/.test(err.message),
  )
})

test('a path under a hidden folder cannot also be made writable', (t) => {
  const root = project(t, ['secrets/out/'])
  assert.throws(
    () => planView(root, config({ 'secrets/': rights(false), 'secrets/out/': rights(true, true) })),
    ViewPolicyError,
  )
})

test('a rule for a path that does not exist adds nothing', (t) => {
  const root = project(t, ['a.txt'])
  const plan = planView(root, config({ 'ghost.txt': rights(false), 'gone/': rights(true, true) }))
  assert.deepEqual(plan, { args: [], hidden: [], writable: [], creatable: [] })
})

test('a symbolic link next to a hidden name stays a link', (t) => {
  const root = project(t, ['secret.txt', 'real.txt'])
  symlinkSync('real.txt', join(root, 'alias'))
  const { args } = planView(root, config({ 'secret.txt': rights(false) }))
  const at = args.indexOf('--symlink')
  assert.ok(at >= 0)
  assert.deepEqual(args.slice(at, at + 3), ['--symlink', 'real.txt', join(root, 'alias')])
})

test('a deeper rebuild comes after the shallower one it lands on', (t) => {
  const root = project(t, ['a.txt', 'one/two/x', 'one/two/y', 'one/z'])
  const { args } = planView(root, config({ 'a.txt': rights(false), 'one/two/x': rights(false) }))
  const tmpfs = args.map((arg, i) => (arg === '--tmpfs' ? args[i + 1] : null)).filter(Boolean)
  assert.deepEqual(tmpfs, [root, join(root, 'one', 'two')])
})

// The policy loader, as the inner step uses it: a path the view hid is not on disk, and that is not an error.
const { loadProjectPolicy, PolicyFileError } = await import(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'guard', 'project-policy.js')).href)

test('a rule for a missing path is refused, unless the view hid that path on purpose', (t) => {
  const root = project(t, ['a.txt'])
  writeFileSync(join(root, '.vajra.json'), JSON.stringify({ version: 1, paths: { 'secret.txt': { read: false }, 'vault/': { read: false } } }))
  assert.throws(() => loadProjectPolicy(root), PolicyFileError)
  const policy = loadProjectPolicy(root, {}, new Set(['secret.txt', 'vault']))
  assert.equal(policy.config.files['secret.txt'].read, false)
  assert.equal(policy.config.files['vault/'].read, false)
  assert.throws(() => loadProjectPolicy(root, {}, new Set(['secret.txt'])), PolicyFileError, 'one allowed path does not excuse another')
})

test('a create folder is bound read-write, then every name already in it is bound back read-only', (t) => {
  const root = project(t, ['keep.txt', '.vajra.json', '.git/HEAD', 'src/a.ts'])
  symlinkSync('keep.txt', join(root, 'link'))
  const plan = planView(root, config({}), [''])
  assert.deepEqual(plan.creatable, ['.'])
  assert.deepEqual(plan.args.slice(0, 3), ['--bind', root, root])
  for (const name of ['keep.txt', '.vajra.json', '.git', 'src']) {
    const at = plan.args.findIndex((arg, i) => arg === '--ro-bind' && plan.args[i + 1] === join(root, name))
    assert.ok(at > 2, `${name} is pinned read-only after the folder is bound`)
  }
  assert.ok(!plan.args.includes(join(root, 'link')), 'a link is left alone: changing it needs delete')
})

test('create on a subfolder pins only that folder, and a write rule inside it is bound read-write after the pin', (t) => {
  const root = project(t, ['top.txt', 'src/a.ts', 'src/gen/b.ts'])
  const plan = planView(root, { ...config({ 'src/gen/': rights(true, true) }) }, ['src/'])
  assert.deepEqual(plan.creatable, ['src'])
  assert.ok(!plan.args.includes(join(root, 'top.txt')))
  const pin = plan.args.findIndex((arg, i) => arg === '--ro-bind' && plan.args[i + 1] === join(root, 'src', 'gen'))
  const write = plan.args.findIndex((arg, i) => arg === '--bind' && plan.args[i + 1] === join(root, 'src', 'gen'))
  assert.ok(pin > 0 && write > pin)
})

test('a name cannot be hidden directly inside a create folder, but a folder further down can be rebuilt', (t) => {
  const root = project(t, ['src/a.ts', 'src/secret.ts', 'src/deep/x', 'src/deep/y'])
  assert.throws(() => planView(root, config({ 'src/secret.ts': rights(false) }), ['src/']), err => err instanceof ViewPolicyError && /allows create/.test(err.message))
  const plan = planView(root, config({ 'src/deep/y': rights(false) }), ['src/'])
  const create = plan.args.indexOf('--bind')
  assert.ok(create < plan.args.indexOf('--tmpfs'), 'the folder is bound first, and the rebuild lands on top')
})

test('create on the root cannot go with a hidden name in the root', (t) => {
  const root = project(t, ['a.txt', 'secret.txt'])
  assert.throws(() => planView(root, config({ 'secret.txt': rights(false) }), ['']), ViewPolicyError)
})
