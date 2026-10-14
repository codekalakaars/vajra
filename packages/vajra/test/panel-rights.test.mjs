import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = join(import.meta.dirname, '..', 'dist')
const { cleanRelative, inheritedRights, listFolder, rightsFor, saveRights, withRights, RightsError } = await import(pathToFileURL(join(dist, 'panel', 'rights.js')).href)
const { loadProjectPolicy } = await import(pathToFileURL(join(dist, 'guard', 'project-policy.js')).href)

function project(t, files, policy) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-panel-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    if (!file.endsWith('/')) writeFileSync(join(root, file), 'x\n')
  }
  if (policy) writeFileSync(join(root, '.vajra.json'), JSON.stringify(policy))
  return root
}
const all = (read, write = false, del = false) => ({ read, write, delete: del })

test('a path with no rule gets the rights of the nearest folder above it, else the default', (t) => {
  const root = project(t, ['src/deep/a.ts', 'top.txt'], { version: 1, paths: { 'src/': { write: true } } })
  const { config } = loadProjectPolicy(root)
  assert.deepEqual(rightsFor(config, 'src/deep/a.ts', false), { rights: all(true, true), source: 'inherited' })
  assert.deepEqual(rightsFor(config, 'top.txt', false), { rights: all(true), source: 'default' })
  assert.equal(rightsFor(config, 'src', true).source, 'rule')
})

test('only the rights that differ from what a path inherits are written', (t) => {
  const root = project(t, ['src/a.ts'], { version: 1, paths: { 'src/': { write: true } } })
  const { config } = loadProjectPolicy(root)
  const changed = withRights({ 'src/': { write: true } }, config, 'src/a.ts', false, all(false))
  assert.deepEqual(changed['src/a.ts'], { read: false, write: false })
  const same = withRights({ 'src/': { write: true }, 'src/a.ts': { read: false } }, config, 'src/a.ts', false, all(true, true))
  assert.equal(same['src/a.ts'], undefined, 'set back to what it inherits, the rule is dropped')
})

test('delete on a single file is refused, with the reason', (t) => {
  const root = project(t, ['a.txt'])
  const { config } = loadProjectPolicy(root)
  assert.throws(() => withRights({}, config, 'a.txt', false, all(true, true, true)), err => err instanceof RightsError && /single file/.test(err.message))
})

test('paths are cleaned: nothing outside the project, nothing odd', () => {
  assert.equal(cleanRelative(''), '')
  assert.equal(cleanRelative('a/b/'), 'a/b')
  for (const bad of ['../x', '/etc', 'a/../b', 'a//b', 'a\\b', 'a\0b', './a', 7]) assert.throws(() => cleanRelative(bad), RightsError, String(bad))
})

test('a listing has folders first, the rights of each entry, and why something cannot be changed', (t) => {
  const root = project(t, ['b.txt', 'a/x', 'node_modules/p/i.js', 'real.txt'], { version: 1, paths: { 'a/': { write: true } } })
  symlinkSync('real.txt', join(root, 'link'))
  const { config } = loadProjectPolicy(root)
  const entries = listFolder(root, '', config)
  assert.deepEqual(entries.filter(e => e.isDir).map(e => e.name), ['a', 'node_modules'])
  assert.equal(entries.find(e => e.name === 'a').rights.write, true)
  assert.match(entries.find(e => e.name === '.vajra.json').locked, /policy file/)
  assert.match(entries.find(e => e.name === 'link').locked, /symbolic link/)
  assert.match(entries.find(e => e.name === 'node_modules').locked, /read and run only/)
  assert.equal(entries.find(e => e.name === 'b.txt').locked, null)
  assert.throws(() => listFolder(root, 'link', config), RightsError, 'a symlink is not a folder to list')
})

test('saving writes the rule to .vajra.json and keeps the rest of the file', (t) => {
  const root = project(t, ['src/a.ts', 'notes.md'], { version: 1, default: { read: true }, paths: { 'src/': { write: true } } })
  saveRights(root, 'notes.md', false, all(true, true))
  const saved = JSON.parse(readFileSync(join(root, '.vajra.json'), 'utf-8'))
  assert.deepEqual(saved.paths, { 'src/': { write: true }, 'notes.md': { write: true } })
  assert.deepEqual(saved.default, { read: true }, 'other keys survive')
})

test('hiding a file writes read: false', (t) => {
  const root = project(t, ['secret.txt'])
  saveRights(root, 'secret.txt', false, all(false))
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.vajra.json'), 'utf-8')).paths, { 'secret.txt': { read: false } })
})

test('a change the shell could not start from is refused and the file is put back exactly', (t) => {
  const original = { version: 1, paths: { 'src/': { write: true } } }
  const root = project(t, ['src/a.ts', 'src/token'], original)
  const before = readFileSync(join(root, '.vajra.json'), 'utf-8')
  // A file in a writable folder cannot lose write, or be hidden: the folder's rights cannot be taken back.
  assert.throws(() => saveRights(root, 'src/token', false, all(false)), err => err instanceof RightsError && /cannot lose write inside src\//.test(err.message))
  assert.equal(readFileSync(join(root, '.vajra.json'), 'utf-8'), before)
})

test('a refused change to a project with no policy file leaves it with none', (t) => {
  const root = project(t, ['a.txt'])
  assert.throws(() => saveRights(root, 'a.txt', false, all(true, true, true)), RightsError)
  assert.equal(existsSync(join(root, '.vajra.json')), false)
  // Taking write away from a file inside a writable folder is also refused, and also leaves no trace.
  writeFileSync(join(root, '.vajra.json'), JSON.stringify({ version: 1, paths: { 'd/': { write: true } } }))
  mkdirSync(join(root, 'd'))
  writeFileSync(join(root, 'd', 'f'), 'x')
  const before = readFileSync(join(root, '.vajra.json'), 'utf-8')
  assert.throws(() => saveRights(root, 'd/f', false, all(true, false)), RightsError)
  assert.equal(readFileSync(join(root, '.vajra.json'), 'utf-8'), before)
})

test('an unusable policy on disk is reported as such, not as a crash', (t) => {
  const root = project(t, ['a.txt'])
  writeFileSync(join(root, '.vajra.json'), '{ not json')
  assert.throws(() => saveRights(root, 'a.txt', false, all(true, true)), err => err instanceof RightsError && /not usable/.test(err.message))
})

test('the root cannot be edited here', (t) => {
  assert.throws(() => saveRights(project(t, []), '', true, all(true)), RightsError)
})

test('hiding a name inside a folder that can only be deleted from is refused by the view, with its own reason', (t) => {
  // delete without write is allowed by the policy, but the folder is still shared with the real project.
  const root = project(t, ['d/f', 'd/g'], { version: 1, paths: { 'd/': { delete: true } } })
  const before = readFileSync(join(root, '.vajra.json'), 'utf-8')
  assert.throws(() => saveRights(root, 'd/g', false, all(false)), err => err instanceof RightsError && /cannot (be hidden inside|lose|be kept from delete)/.test(err.message))
  assert.equal(readFileSync(join(root, '.vajra.json'), 'utf-8'), before)
})
