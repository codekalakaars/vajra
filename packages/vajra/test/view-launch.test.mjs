import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = join(import.meta.dirname, '..', 'dist')
const { bubblewrapArgs, probeBubblewrap } = await import(pathToFileURL(join(dist, 'view', 'launch.js')).href)

const plan = { args: ['--tmpfs', '/p', '--ro-bind', '/p/a', '/p/a', '--remount-ro', '/p'], hidden: ['s'], writable: [] }

test('the machine is bound read-only first, and the project view and command come last', () => {
  const args = bubblewrapArgs({ projectRoot: '/p', view: plan, command: ['node', 'inner.js'] })
  assert.deepEqual(args.slice(0, 5), ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--ro-bind'])
  assert.ok(args.indexOf('--ro-bind') < args.indexOf('--tmpfs'), 'the base comes before anything laid on it')
  const view = args.indexOf('--remount-ro')
  assert.ok(args.indexOf('--tmpfs', args.indexOf('/tmp') - 1) < view, 'the private /tmp comes before the view')
  assert.deepEqual(args.slice(-5), ['--chdir', '/p', '--', 'node', 'inner.js'])
})

test('the network is shared, because Vajra does not restrict it', () => {
  assert.ok(!bubblewrapArgs({ projectRoot: '/p', view: plan, command: ['x'] }).includes('--unshare-net'))
})

test('a project inside /tmp is bound back over the private /tmp, before the view', () => {
  const args = bubblewrapArgs({ projectRoot: '/tmp/proj', view: { args: ['--tmpfs', '/tmp/proj'], hidden: [], writable: [] }, command: ['x'] })
  const tmp = args.indexOf('/tmp')
  const back = args.findIndex((arg, i) => arg === '--ro-bind' && args[i + 1] === '/tmp/proj')
  assert.ok(tmp >= 0 && back > tmp, 'bound back after /tmp is replaced')
  assert.ok(back < args.indexOf('--tmpfs', tmp + 1), 'and before the view is laid on it')
})

test('a project elsewhere is not rebound', () => {
  const args = bubblewrapArgs({ projectRoot: '/home/a/proj', view: plan, command: ['x'] })
  assert.ok(!args.some((arg, i) => arg === '--ro-bind' && args[i + 1] === '/home/a/proj'))
})

test('with no bubblewrap on PATH the probe says so and does not work', () => {
  const status = probeBubblewrap('/nonexistent-dir')
  assert.equal(status.works, false)
  assert.equal(status.path, null)
  assert.match(status.detail, /not installed/)
})

// The whole command, through bubblewrap, Landlock and seccomp. It needs a machine where bubblewrap can
// make its namespaces, which Ubuntu 24.04 and later do not allow without an AppArmor exception.
const view = probeBubblewrap()
const skip = view.works ? false : `bubblewrap cannot build the view here: ${view.detail}`

test('vajra: a hidden name is gone, writes land only where allowed, and the shell cannot get around it', { skip }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-e2e-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'a.txt'), 'inside\n')
  writeFileSync(join(root, 'secret.txt'), 'hidden\n')
  writeFileSync(join(root, '.vajra.json'), JSON.stringify({ version: 1, paths: { 'src/': { write: true }, 'secret.txt': { read: false } } }))

  const script = [
    'ls -A',
    'echo made > src/new.txt && echo wrote-src',
    'echo x > a.txt 2>/dev/null || echo blocked-a',
    'cat secret.txt 2>/dev/null || echo no-secret',
    'exit',
  ].join('\n') + '\n'
  const result = spawnSync('node', [join(dist, 'cli', 'index.js'), '--no-browser'], { cwd: root, input: script, encoding: 'utf-8', env: { ...process.env, SHELL: '/bin/bash' } })

  assert.match(result.stdout, /wrote-src/)
  assert.match(result.stdout, /blocked-a/)
  assert.match(result.stdout, /no-secret/)
  assert.doesNotMatch(result.stdout, /secret\.txt/, 'the name is not even listed')
  assert.equal(spawnSync('cat', [join(root, 'src', 'new.txt')], { encoding: 'utf-8' }).stdout, 'made\n', 'the write reached the real project')
})

test('writable places outside the project are mounted read-write, before the project view', () => {
  const args = bubblewrapArgs({ projectRoot: '/p', view: plan, command: ['x'], binds: ['/home/a/.local/share/opencode'] })
  const at = args.findIndex((arg, i) => arg === '--bind' && args[i + 1] === '/home/a/.local/share/opencode')
  assert.ok(at > args.indexOf('/tmp'), 'after the base and the private /tmp')
  assert.ok(at < args.indexOf('--remount-ro'), 'before the project view')
})

test('vajra: every agent can write its own state directory, and no other place in the home directory', { skip }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-e2e-home-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(project)
  for (const dir of ['.local/share/opencode', '.pi/agent', '.codex', '.claude']) mkdirSync(join(home, dir), { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh/id'), 'key\n')

  const script = [
    'echo log > ~/.local/share/opencode/opencode.log && echo wrote-state',
    'echo k > ~/.pi/agent/auth.json && echo pi-wrote',
    'echo k > ~/.claude/state && echo claude-wrote',
    // Codex makes symlinks to itself in its own tmp directory every time it starts.
    'mkdir -p ~/.codex/tmp/arg0 && ln -s /bin/true ~/.codex/tmp/arg0/apply_patch && echo codex-linked',
    'ln -s /bin/true ~/.pi/escape 2>/dev/null && echo pi-escaped || echo pi-parent-closed',
    'echo x > ~/.local/share/other 2>/dev/null || echo blocked-other',
    'cat ~/.ssh/id 2>/dev/null || echo blocked-ssh',
    'exit',
  ].join('\n') + '\n'
  const result = spawnSync('node', [join(dist, 'cli', 'index.js'), '--no-browser'], { cwd: project, input: script, encoding: 'utf-8', env: { ...process.env, HOME: home, SHELL: '/bin/bash', XDG_DATA_HOME: '', XDG_STATE_HOME: '', XDG_CACHE_HOME: '' } })

  assert.match(result.stdout, /wrote-state/)
  for (const line of [/pi-wrote/, /claude-wrote/, /codex-linked/, /pi-parent-closed/]) assert.match(result.stdout, line)
  assert.match(result.stdout, /blocked-other/)
  assert.match(result.stdout, /blocked-ssh/)
  assert.equal(spawnSync('cat', [join(home, '.local/share/opencode/opencode.log')], { encoding: 'utf-8' }).stdout, 'log\n', 'the write reached the real directory')
})

// The restart: a live shell on a terminal, an "agent" running in it, a rule changed through the control page's API,
// and the shell restarted from the new file with the agent started again by its own continue option.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const hasScript = spawnSync('sh', ['-c', 'command -v script']).status === 0

test('vajra: changing a rule and applying it restarts the shell and resumes the agent that was running', { skip: skip || (hasScript ? false : 'needs the script command for a terminal') }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-e2e-restart-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'a.txt'), 'inside\n')
  writeFileSync(join(root, '.vajra.json'), JSON.stringify({ version: 1, paths: { 'src/': { write: true } } }))
  // A stand-in for an agent. Started plainly it runs as a process named "claude"; started with --continue
  // it leaves a note in a writable folder, which is how this test sees that it was resumed.
  // The launcher puts the sandbox notice in front of the arguments, so it looks for --continue among them all.
  writeFileSync(join(root, 'bin', 'claude'), '#!/bin/bash\nfor a in "$@"; do if [ "$a" = "--continue" ]; then echo resumed > src/resumed.txt; exit 0; fi; done\nprintf "%s\\n" "$@" > src/first-args.txt\nexec -a claude sleep 300\n')
  chmodSync(join(root, 'bin', 'claude'), 0o755)

  const env = { ...process.env, SHELL: '/bin/bash', PATH: `${join(root, 'bin')}:${process.env.PATH}` }
  const vajra = spawn('script', ['-qec', `node ${join(dist, 'cli', 'index.js')} --no-browser`, '/dev/null'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => vajra.kill('SIGKILL'))
  let output = ''
  vajra.stdout.on('data', chunk => { output += chunk })
  vajra.stderr.on('data', chunk => { output += chunk })
  const until = async (pattern, ms = 15000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (pattern.test(output)) return
      await delay(100)
    }
    assert.fail(`never saw ${pattern} in:\n${output}`)
  }

  await until(/#token=[\w-]+/)
  const [, port, token] = output.match(/127\.0\.0\.1:(\d+)\/#token=([\w-]+)/)
  const api = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })

  await until(/Type exit to leave/)
  vajra.stdin.write('claude\n')
  await delay(1500)

  // Allow writing a.txt, and see that the page reports the change as waiting, with the agent it would resume.
  assert.equal((await api('/api/rights', { path: 'a.txt', isDir: false, read: true, write: true, delete: false })).status, 200)
  const waiting = await (await api('/api/status')).json()
  assert.equal(waiting.pending, true)
  assert.equal(waiting.agent, 'claude', output)

  assert.equal((await api('/api/apply', {})).status, 202)
  await until(/rules changed, restarting the shell/)
  await until(/resuming claude/)
  for (let waited = 0; waited < 10000 && !existsSync(join(root, 'src', 'resumed.txt')); waited += 100) await delay(100)
  assert.equal(readFileSync(join(root, 'src', 'resumed.txt'), 'utf-8'), 'resumed\n', 'the agent was started again with --continue')
  assert.match(readFileSync(join(root, 'src', 'first-args.txt'), 'utf-8'), /--append-system-prompt\nVAJRA SANDBOX NOTICE/, 'and the first start was given the sandbox notice')

  // The new shell has the new rule: a.txt is writable now.
  await delay(500)
  vajra.stdin.write('echo changed > a.txt && echo now-writable\n')
  await until(/now-writable/)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf-8'), 'changed\n')
  vajra.stdin.write('exit\n')
  await new Promise(resolve => vajra.once('exit', resolve))
})

test('vajra: inside the shell the notice is there for the agent to read, and cannot be changed', { skip }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-e2e-notice-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'secret.txt'), 'x')
  writeFileSync(join(root, '.vajra.json'), JSON.stringify({ version: 1, paths: { 'src/': { write: true }, 'secret.txt': { read: false } } }))
  const script = [
    'echo "env:$VAJRA:$VAJRA_NOTICE_FILE"',
    'type -p claude opencode',
    'grep -c "You can write: \\"src\\"" "$VAJRA_NOTICE_FILE"',
    'echo tampered > "$VAJRA_NOTICE_FILE" 2>/dev/null && echo notice-changed || echo notice-protected',
    'echo x > /tmp/vajra-shims/claude 2>/dev/null && echo launcher-changed || echo launcher-protected',
    'sudo -n true 2>&1 | head -1',
    'mount | head -1 | cut -c1-5',
    'exit',
  ].join('\n') + '\n'
  const result = spawnSync('node', [join(dist, 'cli', 'index.js'), '--no-browser'], { cwd: root, input: script, encoding: 'utf-8', env: { ...process.env, SHELL: '/bin/bash' } })
  assert.match(result.stdout, /vajra: that command is not available in this sandbox/, 'sudo says why instead of a sudo configuration error')
  assert.doesNotMatch(result.stdout, /no new privileges/)
  assert.match(result.stdout, /env:1:\/tmp\/vajra-shims\/notice\.md/)
  assert.match(result.stdout, /\/tmp\/vajra-shims\/claude/)
  assert.match(result.stdout, /\/tmp\/vajra-shims\/opencode/)
  assert.match(result.stdout, /^1$/m, 'the notice names the writable folder')
  assert.match(result.stdout, /notice-protected/)
  assert.match(result.stdout, /launcher-protected/)
})
