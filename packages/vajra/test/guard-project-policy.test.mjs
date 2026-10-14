import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `.vajra.json` against the real kernel: each right, on files and folders, tried
 * from inside a confined command. The refusals are checked too, since a policy the
 * kernel cannot express must stop the command from starting, not run looser.
 */

const cli = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js')
const enforced = spawnSync('node', [cli, 'doctor'], { encoding: 'utf-8' }).status === 0
const skip = enforced ? false : 'this machine cannot confine file access'

function world(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-policy-test-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  mkdirSync(project)
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'a.txt'), 'inside\n')
  writeFileSync(join(project, 'b.txt'), 'second\n')
  return { root, project }
}

function policy(project, paths) {
  writeFileSync(join(project, '.vajra.json'), JSON.stringify({ version: 1, paths }))
}

function sh(project, script, extra = []) {
  return spawnSync('node', [cli, 'guard', '-q', '--dir', project, ...extra, '--', 'sh', '-c', script], { encoding: 'utf-8' })
}

test('without a policy file the project is read-only: it can be read, nothing is written', { skip }, t => {
  const { project } = world(t)
  const result = sh(project, 'cat a.txt && echo x > new.txt')
  assert.match(result.stdout, /inside/)
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(join(project, 'new.txt')), false)
})

test('a single file can be given write, and the files beside it cannot', { skip }, t => {
  const { project } = world(t)
  policy(project, { 'a.txt': { write: true } })
  assert.equal(sh(project, 'echo changed > a.txt').status, 0)
  assert.equal(readFileSync(join(project, 'a.txt'), 'utf-8'), 'changed\n')

  const beside = sh(project, 'echo changed > b.txt')
  assert.notEqual(beside.status, 0)
  assert.equal(readFileSync(join(project, 'b.txt'), 'utf-8'), 'second\n')
})

test('read: false on a folder makes it unreadable while the rest of the project stays readable', { skip }, t => {
  const { project } = world(t)
  mkdirSync(join(project, 'secrets'))
  writeFileSync(join(project, 'secrets', 'key.txt'), 'KEY\n')
  policy(project, { 'secrets/': { read: false } })
  const hidden = sh(project, 'cat secrets/key.txt')
  assert.notEqual(hidden.status, 0)
  assert.doesNotMatch(hidden.stdout, /KEY/)
  assert.equal(sh(project, 'cat a.txt').status, 0)
})

test('a file inside a closed folder can be opened again', { skip }, t => {
  const { project } = world(t)
  mkdirSync(join(project, 'secrets'))
  writeFileSync(join(project, 'secrets', 'key.txt'), 'KEY\n')
  writeFileSync(join(project, 'secrets', 'open.txt'), 'OPEN\n')
  policy(project, { 'secrets/': { read: false }, 'secrets/open.txt': { read: true } })
  assert.match(sh(project, 'cat secrets/open.txt').stdout, /OPEN/)
  const closed = sh(project, 'cat secrets/key.txt')
  assert.notEqual(closed.status, 0)
  assert.doesNotMatch(closed.stdout, /KEY/)
})

test('read: false on a single file keeps its content from the command', { skip }, t => {
  const { project } = world(t)
  policy(project, { 'b.txt': { read: false } })
  const result = sh(project, 'cat b.txt')
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /second/)
  assert.equal(sh(project, 'cat a.txt').status, 0)
})

test('delete on a folder removes what is in it, but not the folder itself', { skip }, t => {
  const { project } = world(t)
  writeFileSync(join(project, 'src', 'old.txt'), 'old\n')
  policy(project, { 'src/': { write: true, delete: true } })
  assert.equal(sh(project, 'rm src/old.txt').status, 0)
  assert.equal(existsSync(join(project, 'src', 'old.txt')), false)
  assert.notEqual(sh(project, 'rmdir src').status, 0)
  assert.equal(existsSync(join(project, 'src')), true)
})

test('without delete, a file in a writable folder cannot be removed', { skip }, t => {
  const { project } = world(t)
  writeFileSync(join(project, 'src', 'old.txt'), 'old\n')
  policy(project, { 'src/': { write: true } })
  assert.notEqual(sh(project, 'rm src/old.txt').status, 0)
  assert.equal(existsSync(join(project, 'src', 'old.txt')), true)
})

test('the policy file cannot be written, even inside a folder that allows writes', { skip }, t => {
  const { project } = world(t)
  policy(project, { 'src/': { write: true } })
  const before = readFileSync(join(project, '.vajra.json'), 'utf-8')
  const result = sh(project, `echo '{"version":1,"default":{"write":true}}' > .vajra.json`)
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(join(project, '.vajra.json'), 'utf-8'), before)
})

test('a policy that gives delete to a single file refuses to start', { skip }, t => {
  const { project } = world(t)
  policy(project, { 'a.txt': { delete: true } })
  const result = sh(project, 'true')
  assert.equal(result.status, 125)
  assert.match(result.stderr, /cannot have delete on its own/)
})

test('"hidden" refuses to start, and says what to use instead', { skip }, t => {
  const { project } = world(t)
  mkdirSync(join(project, 'secrets'))
  policy(project, { 'secrets/': { hidden: true } })
  const result = sh(project, 'true')
  assert.equal(result.status, 125)
  assert.match(result.stderr, /"hidden" is not supported/)
  assert.match(result.stderr, /"read": false/)
})

test('taking write away from inside a folder that allows it refuses to start', { skip }, t => {
  const { project } = world(t)
  mkdirSync(join(project, 'src', 'gen'))
  policy(project, { 'src/': { write: true }, 'src/gen/': { write: false } })
  const result = sh(project, 'true')
  assert.equal(result.status, 125)
  assert.match(result.stderr, /cannot lose write inside src\//)
})

test('a rule for a path that is not in the project refuses to start', { skip }, t => {
  const { project } = world(t)
  policy(project, { 'missing.txt': { write: true } })
  const result = sh(project, 'true')
  assert.equal(result.status, 125)
  assert.match(result.stderr, /does not exist in the project/)
})

test('a policy file that is not JSON refuses to start', { skip }, t => {
  const { project } = world(t)
  writeFileSync(join(project, '.vajra.json'), '{ nope')
  const result = sh(project, 'true')
  assert.equal(result.status, 125)
  assert.match(result.stderr, /not valid JSON/)
})

test('--dry-run lists each rule the policy file gives', { skip }, t => {
  const { project } = world(t)
  policy(project, { 'src/': { write: true }, 'b.txt': { read: false } })
  const result = spawnSync('node', [cli, 'guard', '--dry-run', '--dir', project, '--', 'true'], { encoding: 'utf-8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /rights    default: read/)
  assert.match(result.stderr, /rights    src\/: read, write/)
  assert.match(result.stderr, /rights    b\.txt: none/)
})

test('a --allow-write path inside the project is ignored, so the policy file still decides', { skip }, t => {
  const { project } = world(t)
  const result = spawnSync('node', [cli, 'guard', '--dry-run', '--dir', project, '--allow-write', join(project, 'src'), '--', 'true'], { encoding: 'utf-8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /ignored .*inside the project/)
})

const dryRun = (project, args) => spawnSync('node', [cli, 'guard', '--dry-run', '--dir', project, ...args, '--', 'true'], { encoding: 'utf-8' })
const rightsLines = text => text.split('\n').filter(line => /^\s+rights\s/.test(line)).map(line => line.trim())

/** The JSON the guard prints after its "save this as" line: two spaces of indent, then the object. */
function printedJson(stderr) {
  const lines = stderr.split('\n')
  const at = lines.findIndex(line => /save this as \.vajra\.json/.test(line))
  assert.notEqual(at, -1, 'the guard prints the policy to save')
  const body = []
  for (let i = at + 1; i < lines.length && lines[i].startsWith('  '); i++) body.push(lines[i].slice(2))
  return JSON.parse(body.join('\n'))
}

test('--write lets the command write there for this run, with no policy file', { skip }, t => {
  const { project } = world(t)
  const result = sh(project, 'echo x > src/new.txt', ['--write', 'src/'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(project, '.vajra.json')), false, 'nothing is saved for the person')
  assert.match(result.stderr, /only for this run/)
  assert.equal(sh(project, 'echo x > b.txt', ['--write', 'src/']).status !== 0, true, 'a path not given is still read-only')
})

test('--write, --delete and --deny-read each work on their own path', { skip }, t => {
  const { project } = world(t)
  writeFileSync(join(project, 'src', 'old.txt'), 'old\n')
  mkdirSync(join(project, 'secrets'))
  writeFileSync(join(project, 'secrets', 'k'), 'KEY\n')
  assert.equal(sh(project, 'echo changed > a.txt', ['--write', 'a.txt']).status, 0)
  assert.equal(sh(project, 'rm src/old.txt', ['--delete', 'src/']).status, 0)
  const closed = sh(project, 'cat secrets/k', ['--deny-read', 'secrets/'])
  assert.notEqual(closed.status, 0)
  assert.doesNotMatch(closed.stdout, /KEY/)
})

test('a path given as absolute, inside the project, means the same as the relative one', { skip }, t => {
  const { project } = world(t)
  const result = sh(project, 'echo x > src/n.txt', ['--write', join(project, 'src') + '/'])
  assert.equal(result.status, 0, result.stderr)
})

test('an absolute path outside the project refuses to start', { skip }, t => {
  const { root, project } = world(t)
  const result = sh(project, 'true', ['--write', join(root, 'outside', 'x/')])
  assert.equal(result.status, 125)
  assert.match(result.stderr, /not a path inside the project/)
})

test('command-line rules are added to the policy file, and the printed JSON says so', { skip }, t => {
  const { project } = world(t)
  mkdirSync(join(project, 'secrets'))
  policy(project, { 'src/': { write: true } })
  const result = dryRun(project, ['--deny-read', 'secrets/'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(printedJson(result.stderr).paths, { 'src/': { write: true }, 'secrets/': { read: false } })
})

test('the JSON the guard prints, saved as the policy file, gives the same rights as the flags did', { skip }, t => {
  const { project } = world(t)
  mkdirSync(join(project, 'secrets'))
  const flags = ['--write', 'src/', '--write', 'a.txt', '--delete', 'src/', '--deny-read', 'secrets/']
  const first = dryRun(project, flags)
  assert.equal(first.status, 0, first.stderr)
  writeFileSync(join(project, '.vajra.json'), JSON.stringify(printedJson(first.stderr), null, 2))
  const saved = dryRun(project, [])
  assert.equal(saved.status, 0, saved.stderr)
  assert.doesNotMatch(saved.stderr, /save this as/, 'nothing left to save once the file says it')
  assert.deepEqual(rightsLines(saved.stderr), rightsLines(first.stderr))
})

test('with no file and no rules, the guard says the project is read-only and prints the file to start from', { skip }, t => {
  const { project } = world(t)
  const result = dryRun(project, [])
  assert.match(result.stderr, /no \.vajra\.json in the project, so it is read-only/)
  assert.deepEqual(printedJson(result.stderr), { version: 1, paths: {} })
})
