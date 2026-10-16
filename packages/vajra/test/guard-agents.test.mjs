import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = join(import.meta.dirname, '..', 'dist', 'guard')
const { AGENTS, resolveAgents, UnknownAgentError } = await import(pathToFileURL(join(dist, 'agents.js')).href)
const { buildGuardPolicy } = await import(pathToFileURL(join(dist, 'policy.js')).href)

const home = '/home/ada'
const at = (name, env = {}) => {
  const profile = AGENTS.find(agent => agent.name === name)
  return { read: profile.read({ home, env }), write: profile.write({ home, env }) }
}

const names = (list) => list.map(agent => agent.name)

test('an agent is picked by the name the person typed, whatever directory it is run from', () => {
  assert.deepEqual(names(resolveAgents(['claude', '-p', 'hi'], undefined, false)), ['claude'])
  assert.deepEqual(names(resolveAgents(['/home/ada/.opencode/bin/opencode'], undefined, false)), ['opencode'])
  assert.deepEqual(names(resolveAgents(['codex', 'exec'], undefined, false)), ['codex'])
})

test('a shell gets every profile, so an agent can be started from inside it', () => {
  assert.deepEqual(names(resolveAgents(['sh'], undefined, false)), ['claude', 'opencode', 'codex', 'pi'])
  assert.deepEqual(names(resolveAgents(['/usr/bin/zsh'], undefined, false)), ['claude', 'opencode', 'codex', 'pi'])
  assert.deepEqual(names(resolveAgents(['/bin/whatever'], undefined, true)), ['claude', 'opencode', 'codex', 'pi'], 'no command given: the interactive shell')
})

test('an unknown program gets no profile', () => {
  assert.deepEqual(resolveAgents(['make', 'test'], undefined, false), [])
})

test('--agent narrows a shell to one profile, none turns profiles off, and a wrong name is an error that lists the right ones', () => {
  assert.deepEqual(names(resolveAgents(['sh'], 'claude', false)), ['claude'])
  assert.deepEqual(names(resolveAgents([], 'codex', true)), ['codex'])
  assert.deepEqual(resolveAgents(['claude'], 'none', false), [])
  assert.deepEqual(resolveAgents([], 'none', true), [])
  assert.throws(() => resolveAgents(['sh'], 'gemini', false), error => error instanceof UnknownAgentError && /claude, opencode, codex, pi or none/.test(error.message))
})

test('claude: its config directory and file, and the cache it writes; nothing shared', () => {
  const { write, read } = at('claude')
  assert.deepEqual(write.sort(), ['/home/ada/.cache/claude-cli-nodejs', '/home/ada/.claude', '/home/ada/.claude.json'])
  assert.deepEqual(read, [])
})

test('claude: CLAUDE_CONFIG_DIR moves the config, and the home .claude is then not granted', () => {
  const { write } = at('claude', { CLAUDE_CONFIG_DIR: '/data/claude' })
  assert.ok(write.includes('/data/claude'))
  assert.ok(!write.includes('/home/ada/.claude'))
  assert.ok(!write.includes('/home/ada/.claude.json'))
})

test('opencode: data, state and cache are writable, config is read-only, and XDG variables are followed', () => {
  const plain = at('opencode')
  assert.deepEqual(plain.write.sort(), ['/home/ada/.cache/opencode', '/home/ada/.local/share/opencode', '/home/ada/.local/state/opencode'])
  assert.deepEqual(plain.read, ['/home/ada/.config/opencode'])
  const moved = at('opencode', { XDG_DATA_HOME: '/data/share', XDG_CONFIG_HOME: 'relative/is/ignored' })
  assert.ok(moved.write.includes('/data/share/opencode'))
  assert.deepEqual(moved.read, ['/home/ada/.config/opencode'], 'a relative XDG value is not trusted')
})

test('codex: ~/.codex, or CODEX_HOME when it is an absolute path', () => {
  assert.deepEqual(at('codex').write, ['/home/ada/.codex'])
  assert.deepEqual(at('codex', { CODEX_HOME: '/data/codex' }).write, ['/data/codex'])
  assert.deepEqual(at('codex', { CODEX_HOME: 'codex' }).write, ['/home/ada/.codex'])
})

test('no profile grants a shared parent: ~/.local, ~/.config, ~/.cache or the home directory', () => {
  const shared = new Set(['/home/ada', '/home/ada/.local', '/home/ada/.config', '/home/ada/.cache', '/home/ada/.local/share', '/home/ada/.local/state'])
  for (const agent of AGENTS) {
    for (const path of [...agent.read({ home, env: {} }), ...agent.write({ home, env: {} })]) {
      assert.ok(!shared.has(path), `${agent.name} must not grant ${path}`)
    }
  }
})

test("a profile's paths are granted when they exist and skipped when they do not, and the summary names them", () => {
  const present = new Set(['/home/ada/.claude', '/usr/bin'])
  const probe = path => (present.has(path) ? { real: path, isDir: true } : null)
  const claude = at('claude')
  const policy = buildGuardPolicy({
    projectDir: '/work/app', home, path: '/usr/bin', tmpDir: '/tmp/vajra-guard-x', allowRead: [], allowWrite: [], probe,
    agents: [{ name: 'claude', ...claude }],
  })
  assert.ok(policy.readWrite.includes('/home/ada/.claude'))
  assert.ok(!policy.readWrite.includes('/home/ada/.claude.json'), 'missing, so skipped')
  assert.match(policy.summary.join('\n'), /agent\s+claude: \/home\/ada\/\.claude \(write\)/)
})

test('every profile of a shell is granted, and the summary warns that they can read each other', () => {
  const present = new Set(['/home/ada/.claude', '/home/ada/.local/share/opencode', '/usr/bin'])
  const probe = path => (present.has(path) ? { real: path, isDir: true } : null)
  const agents = AGENTS.map(agent => ({ name: agent.name, read: agent.read({ home, env: {} }), write: agent.write({ home, env: {} }), ...(agent.note ? { note: agent.note } : {}) }))
  const policy = buildGuardPolicy({
    projectDir: '/work/app', home, path: '/usr/bin', tmpDir: '/tmp/vajra-guard-x', allowRead: [], allowWrite: [], probe, agents,
  })
  assert.ok(policy.readWrite.includes('/home/ada/.claude'))
  assert.ok(policy.readWrite.includes('/home/ada/.local/share/opencode'))
  const text = policy.summary.join('\n')
  assert.match(text, /agent\s+claude: \/home\/ada\/\.claude \(write\)/)
  assert.match(text, /agent\s+opencode: \/home\/ada\/\.local\/share\/opencode \(write\)/)
  assert.match(text, /agents\s+every known agent's own directories/)
})

test('pi: only its agent directory is writable, and its two override variables are followed', () => {
  assert.deepEqual(at('pi').write, ['/home/ada/.pi/agent'])
  assert.deepEqual(at('pi').read, [])
  // PI_CODING_AGENT_DIR moves everything, so the home directory is then not granted. A relative value is ignored.
  assert.deepEqual(at('pi', { PI_CODING_AGENT_DIR: '/data/pi' }).write, ['/data/pi'])
  assert.deepEqual(at('pi', { PI_CODING_AGENT_DIR: 'relative' }).write, ['/home/ada/.pi/agent'])
  assert.deepEqual(at('pi', { PI_CODING_AGENT_SESSION_DIR: '/data/sessions' }).write.sort(), ['/data/sessions', '/home/ada/.pi/agent'])
  assert.ok(!at('pi').write.includes('/home/ada/.pi'), 'not the parent, which is not pi\'s alone')
})

test('pi is picked by name', () => {
  assert.deepEqual(names(resolveAgents(['pi', '--continue'], undefined, false)), ['pi'])
})
