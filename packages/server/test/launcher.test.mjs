// The launcher (session/launcher.ts) end to end: forking, the sandbox
// report reaching the caller's callback, tool dispatch through the resolved
// handle, and stop() behavior. Complements sandbox-tool-dispatch.test.mjs,
// which exercises the worker script directly — this exercises the
// TypeScript-side client of it that SessionManager actually uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { forkSessionLauncher } from '../dist/session/launcher.js'

const require = createRequire(import.meta.url)
const native = require('vajra-native')

const caps = native.sandboxCapabilities()
const enforces = caps.filesystem !== 'unsupported'

function outsideAnyGrant(tag) {
  return mkdtempSync(join(homedir(), `.vajra-launcher-test-${tag}-`))
}

test('the launcher resolves with a handle once the sandbox report arrives', async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = outsideAnyGrant('resolve')
  const reports = []

  const handle = await forkSessionLauncher(
    { sessionId: 's1', projectDir: project, permissions: undefined, allowUnenforced: false },
    (report) => reports.push(report),
  )

  assert.equal(reports.length, 1)
  assert.equal(reports[0].enforced, true)

  handle.stop()
  rmSync(project, { recursive: true, force: true })
})

test('callTool dispatches to the worker and enforces confinement', async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = outsideAnyGrant('project')
  const outside = outsideAnyGrant('outside')
  writeFileSync(join(project, 'app.js'), 'inside')
  writeFileSync(join(outside, 'secret.txt'), 'hunter2')

  const handle = await forkSessionLauncher(
    { sessionId: 's2', projectDir: project, permissions: undefined, allowUnenforced: false },
    () => {},
  )

  try {
    const content = await handle.callTool('read_file', { path: join(project, 'app.js') })
    assert.equal(content, 'inside')

    await assert.rejects(() => handle.callTool('read_file', { path: join(outside, 'secret.txt') }))
  } finally {
    handle.stop()
    rmSync(project, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('stop() rejects any calls still pending', async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = outsideAnyGrant('stop')
  const handle = await forkSessionLauncher(
    { sessionId: 's3', projectDir: project, permissions: undefined, allowUnenforced: false },
    () => {},
  )

  // Long enough that stop() is guaranteed to run first; short enough that a
  // leftover grandchild process (the worker's own kill() doesn't reach its
  // children) doesn't linger meaningfully after the test finishes.
  const pending = handle.callTool('run_command', {
    command: process.platform === 'win32' ? 'cmd' : 'sleep',
    args: process.platform === 'win32' ? ['/C', 'timeout /T 2'] : ['2'],
  })

  handle.stop()

  await assert.rejects(() => pending, /Session stopped/)
  rmSync(project, { recursive: true, force: true })
})

test('an unenforceable platform is refused by the launcher, not silently accepted', async (t) => {
  if (enforces) {
    t.skip('this platform enforces; refusal path not reachable')
    return
  }

  const project = outsideAnyGrant('refuse')

  await assert.rejects(
    () => forkSessionLauncher({ sessionId: 's4', projectDir: project, permissions: undefined, allowUnenforced: false }, () => {}),
    /Refusing to continue unconfined/,
  )

  const reports = []
  const handle = await forkSessionLauncher(
    { sessionId: 's5', projectDir: project, permissions: undefined, allowUnenforced: true },
    (report) => reports.push(report),
  )
  assert.equal(reports[0].enforced, false)
  handle.stop()

  rmSync(project, { recursive: true, force: true })
})

test("the OpenRouter API key never reaches the worker's environment", async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  // This is the concrete instance of the security invariant: a secret held
  // by the parent process must not be observable from inside the sandboxed
  // child, including by anything the agent tells it to run. Using
  // run_command's own output — rather than a one-off debug hook — proves
  // the isolation the way the real agent loop would actually exercise it.
  //
  // Uses printenv/cmd, a system binary the sandbox's default grants already
  // cover (/usr, /bin, /etc, ...) — not the test's own Node binary. An
  // NVM-installed Node typically lives under $HOME/.nvm/..., which those
  // default grants deliberately do not include, so spawning it here would
  // fail on EXECUTE for an unrelated reason and prove nothing about the key.
  const sentinel = 'sk-sentinel-should-not-leak'
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = sentinel

  const project = outsideAnyGrant('key-isolation')

  try {
    const handle = await forkSessionLauncher(
      { sessionId: 's6', projectDir: project, permissions: undefined, allowUnenforced: false },
      () => {},
    )

    try {
      const result =
        process.platform === 'win32'
          ? await handle.callTool('run_command', { command: 'cmd', args: ['/C', 'echo %OPENROUTER_API_KEY%'] })
          : await handle.callTool('run_command', { command: 'printenv', args: ['OPENROUTER_API_KEY'] })

      const output = result.stdout.trim()
      // printenv exits nonzero with empty output when the var is unset; cmd
      // echoes the literal `%OPENROUTER_API_KEY%` when it isn't defined —
      // either way, what matters is the sentinel never appears.
      assert.ok(!output.includes(sentinel), `expected no leak, got: ${JSON.stringify(output)}`)
    } finally {
      handle.stop()
    }
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
    rmSync(project, { recursive: true, force: true })
  }
})
