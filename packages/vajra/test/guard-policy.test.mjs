import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { buildGuardPolicy } = await import(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'guard', 'policy.js')).href)

/** A fake machine: the listed directories exist, and everything else does not. */
function machine(dirs, files = []) {
  const kinds = new Map([...dirs.map(d => [d, true]), ...files.map(f => [f, false])])
  return path => (kinds.has(path) ? { real: path, isDir: kinds.get(path) } : null)
}

const base = (over = {}) => ({
  projectDir: '/work/app',
  home: '/home/ada',
  path: '/usr/bin:/bin',
  tmpDir: '/tmp/vajra-guard-abc',
  allowRead: [],
  allowWrite: [],
  agents: [],
  probe: machine(['/usr/bin', '/bin']),
  ...over,
})

test('the programs on PATH are readable and runnable, and the private temp directory is writable', () => {
  const policy = buildGuardPolicy(base())
  assert.deepEqual(policy.readExecute.sort(), ['/bin', '/usr/bin'])
  assert.deepEqual(policy.readWrite, ['/tmp/vajra-guard-abc'])
})

test('a bin directory brings its parent, because the programs load libraries from beside it', () => {
  const nvm = '/home/ada/.nvm/versions/node/v24/bin'
  const policy = buildGuardPolicy(base({ path: nvm, probe: machine([nvm, '/home/ada/.nvm/versions/node/v24']) }))
  assert.ok(policy.readExecute.includes('/home/ada/.nvm/versions/node/v24'))
})

test('~/.local/bin does not open ~/.local, which holds keyrings, and neither does ~/bin open the home directory', () => {
  const policy = buildGuardPolicy(base({
    path: '/home/ada/.local/bin:/home/ada/bin',
    probe: machine(['/home/ada/.local/bin', '/home/ada/bin', '/home/ada/.local', '/home/ada']),
  }))
  assert.deepEqual(policy.readExecute.sort(), ['/home/ada/.local/bin', '/home/ada/bin'])
})

test('shims directories of known tool managers bring their parent, so a shim can reach the manager', () => {
  const policy = buildGuardPolicy(base({
    path: '/home/ada/.pyenv/shims',
    probe: machine(['/home/ada/.pyenv/shims', '/home/ada/.pyenv']),
  }))
  assert.ok(policy.readExecute.includes('/home/ada/.pyenv'))
})

test('~/.cargo/bin does not open ~/.cargo, which holds a registry token', () => {
  const policy = buildGuardPolicy(base({
    path: '/home/ada/.cargo/bin',
    probe: machine(['/home/ada/.cargo/bin', '/home/ada/.cargo']),
  }))
  assert.deepEqual(policy.readExecute, ['/home/ada/.cargo/bin'])
})

test("the command's own directory is granted even when no PATH entry covers it, but never the home directory or the root", () => {
  const dir = '/home/ada/.local/share/claude/versions/2.1'
  assert.ok(buildGuardPolicy(base({ commandDir: dir, probe: machine([dir]) })).readExecute.includes(dir))
  for (const broad of ['/', '/home/ada']) {
    const policy = buildGuardPolicy(base({ commandDir: broad, probe: machine([broad]) }))
    assert.ok(!policy.readExecute.includes(broad), `${broad} must not be granted`)
  }
})

test('PATH entries that would grant too much, or mean something different later, are dropped', () => {
  const policy = buildGuardPolicy(base({
    path: ['', '.', 'relative/bin', '/', '/home/ada', '/usr/bin', '/does/not/exist'].join(':'),
    probe: machine(['/', '/home/ada', '/usr/bin']),
  }))
  assert.deepEqual(policy.readExecute, ['/usr/bin'], 'empty, relative, the root, the home directory and missing entries are not granted')
})

test('git config is readable when it exists, devices a terminal needs are writable when they exist', () => {
  const policy = buildGuardPolicy(base({
    probe: machine(['/usr/bin', '/bin', '/dev/pts', '/home/ada/.config/git'], ['/home/ada/.gitconfig', '/dev/tty']),
  }))
  assert.ok(policy.readExecute.includes('/home/ada/.gitconfig'))
  assert.ok(policy.readExecute.includes('/home/ada/.config/git'))
  assert.ok(policy.readWrite.includes('/dev/tty'))
  assert.ok(policy.readWrite.includes('/dev/pts'))
})

test('nothing in the home directory is granted by default', () => {
  const policy = buildGuardPolicy(base({ probe: machine(['/usr/bin', '/bin', '/home/ada/.ssh', '/home/ada/.aws']) }))
  for (const path of [...policy.readExecute, ...policy.readWrite]) {
    assert.ok(!path.startsWith('/home/ada'), `${path} must not be granted`)
  }
})

test('what the person allows is added, and a path that does not exist is an error, not a silent no-op', () => {
  const probe = machine(['/usr/bin', '/home/ada/.claude', '/data'])
  const policy = buildGuardPolicy(base({ probe, allowWrite: ['/home/ada/.claude'], allowRead: ['/data'] }))
  assert.ok(policy.readWrite.includes('/home/ada/.claude'))
  assert.ok(policy.readExecute.includes('/data'))
  assert.throws(() => buildGuardPolicy(base({ probe, allowWrite: ['/home/ada/.cluade'] })), /--allow-write .*no such file/)
  assert.throws(() => buildGuardPolicy(base({ probe, allowRead: ['/nope'] })), /--allow-read .*no such file/)
})

test('the whole machine cannot be granted by an option', () => {
  assert.throws(() => buildGuardPolicy(base({ probe: machine(['/']), allowRead: ['/'] })), /whole machine/)
})

test('the summary says what is granted and what is denied', () => {
  const text = buildGuardPolicy(base({ probe: machine(['/usr/bin', '/home/ada/.claude']), allowWrite: ['/home/ada/.claude'] })).summary.join('\n')
  assert.match(text, /project\s+\/work\/app/)
  assert.match(text, /writable\s+\/home\/ada\/\.claude/)
  assert.match(text, /denied\s+everything else, including the home directory/)
})
