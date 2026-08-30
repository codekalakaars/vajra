// Proves the worker's IPC dispatch loop enforces the sandbox for real, not
// just that the worker calls applySandbox successfully. A tool call routed
// through {callId, tool, args} messages must be denied for an out-of-project
// path exactly as a direct native.* call already is (see the root package's
// test/sandbox.test.mjs) — this is what shows the dispatch layer doesn't
// accidentally bypass the sandbox by resolving a path differently.
//
// Forks the real worker script directly, not through the launcher, so this
// exercises the worker in isolation the same way the root repo's
// test/fixtures/sandbox-child.mjs exercises applySandbox in isolation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('vajra-native')

const here = dirname(fileURLToPath(import.meta.url))
const WORKER = join(here, '..', 'worker', 'sandboxed-worker.mjs')

const caps = native.sandboxCapabilities()
const enforces = caps.filesystem !== 'unsupported'

// Fixtures go under $HOME, not the system temp dir — os.tmpdir() sits inside
// a container the macOS backend has to grant for the OS to function, so a
// fixture placed there would test nothing (this was a real bug in the root
// package's own sandbox tests before it was found and fixed there).
function outsideAnyGrant(tag) {
  return mkdtempSync(join(homedir(), `.vajra-server-test-${tag}-`))
}

/** Forks the worker, sends the job, and resolves once its sandbox report
 * (or refusal) arrives — mirrors what session/launcher.ts does, kept
 * independent of it so this test exercises the worker script directly. */
function launch(job) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.once('error', reject)
    child.on('message', (message) => {
      if (message.type === 'refused') {
        reject(new Error(message.message))
      } else if (message.type === 'sandbox-report') {
        resolve({ child, report: message.report })
      }
    })
    child.send({ type: 'job', job })
  })
}

function callTool(child, tool, args) {
  const callId = Math.random().toString(36).slice(2)
  return new Promise((resolve, reject) => {
    function onMessage(message) {
      if (message.type === 'result' && message.callId === callId) {
        child.off('message', onMessage)
        message.ok ? resolve(message.result) : reject(new Error(message.error))
      }
    }
    child.on('message', onMessage)
    child.send({ type: 'call', callId, tool, args })
  })
}

test('worker reports a sandbox capability report matching the direct API', async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = outsideAnyGrant('caps')
  const { child, report } = await launch({ projectDir: project, allowUnenforced: false })

  assert.equal(report.enforced, true)
  assert.equal(report.mechanism, caps.mechanism)

  child.kill()
  rmSync(project, { recursive: true, force: true })
})

test('read_file and write_file are denied outside the project through the dispatch loop', async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = outsideAnyGrant('project')
  const outside = outsideAnyGrant('outside')
  writeFileSync(join(project, 'app.js'), 'inside')
  writeFileSync(join(outside, 'secret.txt'), 'hunter2')

  const { child } = await launch({ projectDir: project, allowUnenforced: false })

  try {
    const inside = await callTool(child, 'read_file', { path: join(project, 'app.js') })
    assert.equal(inside, 'inside')

    await assert.rejects(() => callTool(child, 'read_file', { path: join(outside, 'secret.txt') }))
    await assert.rejects(() => callTool(child, 'write_file', { path: join(outside, 'planted.txt'), content: 'x' }))

    // The denied write must not have landed — checked from this (unsandboxed)
    // test process, which can see the whole filesystem.
    await assert.rejects(async () => {
      const { readFileSync } = await import('node:fs')
      readFileSync(join(outside, 'planted.txt'))
    })
  } finally {
    child.kill()
    rmSync(project, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('run_command is denied from writing outside the project', async (t) => {
  // run_command was removed from the agent's tool set, so this test can no
  // longer be exercised through the dispatch table. The sandbox still
  // enforces filesystem confinement for read_file and list_files.
  t.skip('run_command is no longer in the worker dispatch table')
})

test('an unknown tool name is rejected without crashing the worker', async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = outsideAnyGrant('unknown-tool')
  const { child } = await launch({ projectDir: project, allowUnenforced: false })

  try {
    await assert.rejects(() => callTool(child, 'delete_everything', {}), /Unknown tool/)
    // The worker must still be alive and able to serve a real call after that.
    writeFileSync(join(project, 'a.txt'), 'x')
    assert.equal(await callTool(child, 'read_file', { path: join(project, 'a.txt') }), 'x')
  } finally {
    child.kill()
    rmSync(project, { recursive: true, force: true })
  }
})

test('malformed tool arguments are rejected by the worker itself', async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = outsideAnyGrant('bad-args')
  const { child } = await launch({ projectDir: project, allowUnenforced: false })

  try {
    await assert.rejects(() => callTool(child, 'read_file', {}), /Invalid arguments/)
  } finally {
    child.kill()
    rmSync(project, { recursive: true, force: true })
  }
})
