import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `vajra guard` against the real kernel: a command is started under Landlock and
 * tried against files inside and outside the project. These skip on a machine that
 * cannot confine, because there is nothing to check there.
 */

const cli = join(import.meta.dirname, 'support', 'guard-cli.mjs')
const vajra = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js')
const { sandboxCapabilities } = await import('@codekalakaars/vajra-sandbox')
const enforced = sandboxCapabilities().filesystem === 'enforced'
const skip = enforced ? false : 'this machine cannot confine file access'

/** A project, and a sibling directory that is outside it and holds a secret. */
function world(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-guard-test-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const outside = join(root, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'a.txt'), 'inside\n')
  writeFileSync(join(outside, 'secret.txt'), 'outside\n')
  return { root, project, outside }
}

/** Write the project's `.vajra.json`. Without one, the project is read-only. */
function policy(project, paths) {
  writeFileSync(join(project, '.vajra.json'), JSON.stringify({ version: 1, paths }))
}

function guard(project, args, extra = []) {
  return spawnSync('node', [cli, 'guard', '-q', '--dir', project, ...extra, '--', ...args], { encoding: 'utf-8' })
}
const sh = (project, script, extra) => guard(project, ['sh', '-c', script], extra)

test('the command can read the project and write where the policy allows', { skip }, t => {
  const { project } = world(t)
  policy(project, { 'src/': { write: true } })
  const result = sh(project, 'cat a.txt && echo made > src/made.txt')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'inside\n')
  assert.equal(readFileSync(join(project, 'src', 'made.txt'), 'utf-8'), 'made\n')
})

test('files the command creates are readable and runnable, not just writable', { skip }, t => {
  const { project } = world(t)
  policy(project, { 'src/': { write: true } })
  const result = sh(project, 'printf "echo ran\\n" > src/run.sh && chmod +x src/run.sh && src/run.sh && cat src/run.sh')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^ran\n/)
})

test('a file outside the project cannot be read, and none can be written', { skip }, t => {
  const { project, outside } = world(t)
  const read = sh(project, `cat ${outside}/secret.txt`)
  assert.notEqual(read.status, 0)
  assert.match(read.stderr, /Permission denied/)
  assert.doesNotMatch(read.stdout, /outside/)

  const write = sh(project, `echo pwned > ${outside}/pwned.txt`)
  assert.notEqual(write.status, 0)
  assert.equal(existsSync(join(outside, 'pwned.txt')), false)

  const overwrite = sh(project, `echo pwned > ${outside}/secret.txt`)
  assert.notEqual(overwrite.status, 0)
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf-8'), 'outside\n')
})

test('the home directory is closed: a fake .ssh in a HOME the command is given cannot be listed', { skip }, t => {
  const { root, project } = world(t)
  const home = join(root, 'home')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n')
  const result = spawnSync('node', [cli, 'guard', '-q', '--dir', project, '--', 'sh', '-c', `cat ${home}/.ssh/id_ed25519`], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
  })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /PRIVATE KEY/)
})

test('the command gets a private TMPDIR it can use, and it is gone afterwards', { skip }, async t => {
  const { project } = world(t)
  const result = sh(project, 'echo data > "$TMPDIR/f" && cat "$TMPDIR/f" && echo "$TMPDIR"')
  assert.equal(result.status, 0, result.stderr)
  const [data, dir] = result.stdout.trim().split('\n')
  assert.equal(data, 'data')
  assert.match(dir, /vajra-guard-/)
  for (let i = 0; i < 30 && existsSync(dir); i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(existsSync(dir), false, 'removed once the guard has exited')
})

test('the shared /tmp is not writable', { skip }, t => {
  const { project } = world(t)
  const name = `vajra-guard-probe-${process.pid}`
  const result = sh(project, `echo x > /tmp/${name}`)
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(`/tmp/${name}`), false)
})

test("the command's exit code is the guard's exit code", { skip }, t => {
  const { project } = world(t)
  assert.equal(sh(project, 'exit 7').status, 7)
  assert.equal(sh(project, 'exit 0').status, 0)
})

test('a command that is not found exits 127 and says so', { skip }, t => {
  const { project } = world(t)
  const result = guard(project, ['no-such-command-xyz'])
  assert.equal(result.status, 127)
  assert.match(result.stderr, /command not found: no-such-command-xyz/)
})

test('a project that does not exist is a setup error, 125', { skip }, t => {
  const { root } = world(t)
  const result = guard(join(root, 'missing'), ['true'])
  assert.equal(result.status, 125)
  assert.match(result.stderr, /project directory does not exist/)
})

test('--allow-write opens one more place, and --allow-read lets a single file be read', { skip }, t => {
  const { project, outside } = world(t)
  const shared = join(outside, 'shared')
  mkdirSync(shared)
  const write = sh(project, `echo ok > ${shared}/note.txt`, ['--allow-write', shared])
  assert.equal(write.status, 0, write.stderr)
  assert.equal(readFileSync(join(shared, 'note.txt'), 'utf-8'), 'ok\n')

  const read = sh(project, `cat ${outside}/secret.txt`, ['--allow-read', join(outside, 'secret.txt')])
  assert.equal(read.status, 0, read.stderr)
  assert.equal(read.stdout, 'outside\n')
})

test('an --allow-* path that does not exist refuses to start', { skip }, t => {
  const { project, outside } = world(t)
  const result = sh(project, 'true', ['--allow-write', join(outside, 'typo')])
  assert.equal(result.status, 125)
  assert.match(result.stderr, /--allow-write .*no such file/)
})

test('--dry-run prints the policy and confines nothing', { skip }, t => {
  const { project, outside } = world(t)
  const result = spawnSync('node', [cli, 'guard', '--dry-run', '--dir', project, '--', 'sh', '-c', `echo ran > ${outside}/ran.txt`], { encoding: 'utf-8' })
  assert.equal(result.status, 0)
  assert.match(result.stderr, /project\s+/)
  assert.equal(existsSync(join(outside, 'ran.txt')), false, 'the command did not run')
})

test('with no command it starts the SHELL, confined', { skip }, t => {
  const { project, outside } = world(t)
  const result = spawnSync('node', [cli, 'guard', '-q', '--dir', project], {
    encoding: 'utf-8',
    input: `cat ${outside}/secret.txt; echo "still: $VAJRA_GUARD"\nexit\n`,
    env: { ...process.env, SHELL: '/bin/sh' },
  })
  assert.doesNotMatch(result.stdout, /^outside$/m)
  assert.match(result.stdout, new RegExp(`still: ${project}`))
})

test('an agent profile opens that agent\'s own state and nothing beside it', { skip }, t => {
  const { root, project } = world(t)
  const home = join(root, 'home')
  for (const dir of ['.claude', '.local/share/opencode', '.ssh']) mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, '.ssh', 'id'), 'PRIVATE KEY\n')
  writeFileSync(join(home, '.local/share/opencode', 'auth.json'), 'OPENCODE TOKEN\n')
  const run = (agent, script) => spawnSync('node', [cli, 'guard', '-q', '--dir', project, '--agent', agent, '--', 'sh', '-c', script], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', XDG_DATA_HOME: '', XDG_STATE_HOME: '', XDG_CACHE_HOME: '', XDG_CONFIG_HOME: '' },
  })

  const own = run('claude', `echo history > ${home}/.claude/history && cat ${home}/.claude/history`)
  assert.equal(own.status, 0, own.stderr)
  assert.equal(own.stdout, 'history\n')

  const other = run('claude', `cat ${home}/.local/share/opencode/auth.json`)
  assert.notEqual(other.status, 0, "claude's profile must not open opencode's login")
  assert.doesNotMatch(other.stdout, /OPENCODE TOKEN/)

  const ssh = run('claude', `cat ${home}/.ssh/id`)
  assert.notEqual(ssh.status, 0)
  assert.doesNotMatch(ssh.stdout, /PRIVATE KEY/)

  const opencode = run('opencode', `cat ${home}/.local/share/opencode/auth.json`)
  assert.equal(opencode.status, 0, opencode.stderr)
  assert.equal(opencode.stdout, 'OPENCODE TOKEN\n')
  const crossed = run('opencode', `echo x > ${home}/.claude/history`)
  assert.notEqual(crossed.status, 0, "opencode's profile must not open claude's state")
})

test('a bare guard is a shell that can use every agent\'s own directories, and nothing else of theirs', { skip }, t => {
  const { root, project } = world(t)
  const home = join(root, 'home')
  for (const dir of ['.claude', '.local/share/opencode', '.ssh']) mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, '.local/share/opencode', 'auth.json'), 'OPENCODE TOKEN\n')
  writeFileSync(join(home, '.ssh', 'id'), 'PRIVATE KEY\n')
  const env = { ...process.env, HOME: home, SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: '', XDG_DATA_HOME: '', XDG_STATE_HOME: '', XDG_CACHE_HOME: '', XDG_CONFIG_HOME: '' }
  const shell = (input, extra = []) => spawnSync('node', [cli, 'guard', '-q', '--dir', project, ...extra], { encoding: 'utf-8', input, env })

  const result = shell(`echo history > ${home}/.claude/history && cat ${home}/.local/share/opencode/auth.json; cat ${home}/.ssh/id; echo done\nexit\n`)
  assert.match(result.stdout, /OPENCODE TOKEN/, 'the opencode login can be read from the shell')
  assert.ok(existsSync(join(home, '.claude', 'history')), 'claude state can be written from the shell')
  assert.doesNotMatch(result.stdout, /PRIVATE KEY/)
  assert.match(result.stdout, /done/)

  const narrowed = shell(`cat ${home}/.local/share/opencode/auth.json; echo done\nexit\n`, ['--agent', 'claude'])
  assert.doesNotMatch(narrowed.stdout, /OPENCODE TOKEN/, '--agent claude keeps opencode\'s login out of reach')
  assert.match(narrowed.stdout, /done/)
})

test('an agent started from the shell runs when it is a symlink into its own install directory', { skip }, t => {
  const { root, project } = world(t)
  const home = join(root, 'home')
  const versions = join(home, '.local', 'share', 'fakeagent', 'versions')
  mkdirSync(versions, { recursive: true })
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(versions, '1.0'), '#!/bin/sh\necho fake-claude-ran\n', { mode: 0o755 })
  symlinkSync(join(versions, '1.0'), join(home, '.local', 'bin', 'claude'))
  mkdirSync(join(home, '.claude'))
  const result = spawnSync('node', [cli, 'guard', '-q', '--dir', project], {
    encoding: 'utf-8',
    input: 'claude\nexit\n',
    env: { ...process.env, HOME: home, SHELL: '/bin/sh', PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}` },
  })
  assert.match(result.stdout, /fake-claude-ran/)
})

test('opencode config is read-only, so an agent cannot rewrite its own settings', { skip }, t => {
  const { root, project } = world(t)
  const home = join(root, 'home')
  mkdirSync(join(home, '.config/opencode'), { recursive: true })
  writeFileSync(join(home, '.config/opencode/config.json'), '{}\n')
  const result = spawnSync('node', [cli, 'guard', '-q', '--dir', project, '--agent', 'opencode', '--', 'sh', '-c', `cat ${home}/.config/opencode/config.json && echo x >> ${home}/.config/opencode/config.json`], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '' },
  })
  assert.match(result.stdout, /\{\}/, 'readable')
  assert.notEqual(result.status, 0, 'but not writable')
  assert.equal(readFileSync(join(home, '.config/opencode/config.json'), 'utf-8'), '{}\n')
})

test('vajra --help lists doctor and no guard or shell command', () => {
  const out = spawnSync('node', [vajra, '--help'], { encoding: 'utf-8' }).stdout
  assert.match(out, /doctor/)
  assert.doesNotMatch(out, /^\s+(guard|shell)\b/m)
})

// The filter is tested through perl's raw syscall(), with the x86_64 call numbers. Each call is
// one that behaves differently with and without the filter, so a pass means the filter was there.
const perl = spawnSync('sh', ['-c', 'command -v perl']).status === 0
const rawCalls = enforced && perl && process.arch === 'x64' ? false : 'needs a confining machine, perl and x86_64'
const rawCall = (number, args) => `perl -e 'my $r = syscall(${number}, ${args}); print $r < 0 ? $!+0 : "ok"'`

test('seccomp: ptrace is refused, and io_uring and new namespaces with it', { skip: rawCalls }, (t) => {
  const { project } = world(t)
  const EPERM = '1'
  // ptrace of a pid that does not exist is ESRCH when allowed; the filter answers EPERM first.
  assert.equal(sh(project, rawCall(101, '16, 999999999, 0, 0')).stdout, EPERM, 'ptrace')
  assert.equal(sh(project, rawCall(425, '0, 0')).stdout, EPERM, 'io_uring_setup')
  assert.equal(sh(project, rawCall(272, '0')).stdout, EPERM, 'unshare, which is a no-op when allowed')
  assert.equal(sh(project, rawCall(165, '0, 0, 0, 0, 0')).stdout, EPERM, 'mount')
})

test('seccomp: the same calls behave differently without the filter', { skip: rawCalls }, () => {
  // The control for the test above: plain perl, no guard.
  const plain = (number, args) => spawnSync('sh', ['-c', rawCall(number, args)], { encoding: 'utf-8' }).stdout
  assert.equal(plain(101, '16, 999999999, 0, 0'), '3', 'ptrace of a missing pid is ESRCH')
  assert.equal(plain(272, '0'), 'ok', 'unshare(0) succeeds')
})

test('seccomp: ordinary work still runs under the filter', { skip: enforced ? false : 'cannot confine' }, (t) => {
  const { project } = world(t)
  // fork, threads, pipes, node and a compiler-style workload all make syscalls the filter must leave alone.
  const result = sh(project, 'echo a | cat | wc -c; node -e "setTimeout(() => console.log(process.version.length > 0), 10)"; (sleep 0.1 &) ; wait')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /2/)
  assert.match(result.stdout, /true/)
})

test('seccomp: a command cannot type into the terminal it shares with the person', { skip: rawCalls }, (t) => {
  const { project } = world(t)
  // TIOCSTI on stdin, which is a pipe here: ENOTTY (25) when allowed, EPERM (1) from the filter.
  assert.equal(sh(project, rawCall(16, '0, 0x5412, 0')).stdout, '1')
  const plain = spawnSync('sh', ['-c', rawCall(16, '0, 0x5412, 0')], { encoding: 'utf-8' })
  assert.equal(plain.stdout, '25', 'control: without the filter the call reaches the terminal check')
})
