// Regression: session.create must fold .vajra-sandbox.json fileRules into the
// LaunchJob so the worker enforces them at the OS level (Landlock/Seatbelt),
// not just as a per-tool-call software check.
//
// Before the fix, session.create built a LaunchJob with only permissions and
// allowUnenforced — fileRules and defaultFilePermissions were never passed.
// The worker still had its own per-tool-call check, but the OS-level sandbox
// had no knowledge of the rules, so a compromised worker could bypass them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('@codekalakaars/vajra-core')
const caps = native.sandboxCapabilities()
const enforces = caps.filesystem !== 'unsupported'

function makeProject(tag) {
  return mkdtempSync(join(homedir(), `.vajra-session-filerules-${tag}-`))
}

// ---------------------------------------------------------------------------
// Unit test: mock launcher captures the job
// ---------------------------------------------------------------------------

test('session.create passes fileRules from .vajra-sandbox.json to the launcher', async () => {
  // Build the SessionManager with a mock launcher that captures the job.
  const { SessionManager } = require('../dist/session/manager.js')

  let capturedJob = null
  const mockLauncher = async (job, _onReport) => {
    capturedJob = job
    return {
      callTool: async () => { throw new Error('not implemented') },
      stop: () => {},
    }
  }

  const db = makeInMemoryDb()
  const events = makeEvents()
  const manager = new SessionManager(db, mockLauncher, events)

  const project = makeProject('unit')
  writeFileSync(
    join(project, '.vajra-sandbox.json'),
    JSON.stringify({
      version: 1,
      defaultPermissions: { read: true, write: false, edit: false, delete: false },
      fileRules: [
        { pattern: 'src/**', write: true },
        { pattern: '*.env', read: false },
      ],
    }),
  )

  try {
    await manager.create(
      {
        projectDir: project,
        permissions: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: {} },
        task: 'test task',
        model: 'test-model',
      },
      () => {},
    )

    assert.ok(capturedJob, 'launcher should have been called')
    assert.ok(Array.isArray(capturedJob.fileRules), 'fileRules should be an array')
    assert.equal(capturedJob.fileRules.length, 2, 'fileRules should have 2 entries')
    assert.equal(capturedJob.fileRules[0].pattern, 'src/**')
    assert.equal(capturedJob.fileRules[0].write, true)
    assert.equal(capturedJob.fileRules[1].pattern, '*.env')
    assert.equal(capturedJob.fileRules[1].read, false)
    assert.ok(capturedJob.defaultFilePermissions, 'defaultFilePermissions should be set')
    assert.equal(capturedJob.defaultFilePermissions.read, true)
    assert.equal(capturedJob.defaultFilePermissions.write, false)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('session.create works without .vajra-sandbox.json (no fileRules)', async () => {
  const { SessionManager } = require('../dist/session/manager.js')

  let capturedJob = null
  const mockLauncher = async (job, _onReport) => {
    capturedJob = job
    return {
      callTool: async () => { throw new Error('not implemented') },
      stop: () => {},
    }
  }

  const db = makeInMemoryDb()
  const events = makeEvents()
  const manager = new SessionManager(db, mockLauncher, events)

  const project = makeProject('no-config')

  try {
    await manager.create(
      {
        projectDir: project,
        permissions: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: {} },
        task: 'test task',
        model: 'test-model',
      },
      () => {},
    )

    assert.ok(capturedJob, 'launcher should have been called')
    assert.ok(!capturedJob.fileRules, 'fileRules should be undefined when no config exists')
    assert.ok(!capturedJob.defaultFilePermissions, 'defaultFilePermissions should be undefined when no config exists')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Integration test: real launcher + worker enforces fileRules
// ---------------------------------------------------------------------------

test('worker enforces fileRules from .vajra-sandbox.json via OS-level sandbox', async (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const { forkSessionLauncher } = require('../dist/session/launcher.js')

  const project = makeProject('integration')
  // Create files: secret.env should be unreadable, readme.txt should be readable
  writeFileSync(join(project, 'secret.env'), 'API_KEY=supersecret')
  writeFileSync(join(project, 'readme.txt'), 'hello')
  writeFileSync(
    join(project, '.vajra-sandbox.json'),
    JSON.stringify({
      version: 1,
      defaultPermissions: { read: true, write: false, edit: false, delete: false },
      fileRules: [
        { pattern: '*.env', read: false },
      ],
    }),
  )

  // Load the config like session.create does
  const { loadSandboxConfig } = require('@codekalakaars/vajra-sandbox')
  const sandboxConfig = loadSandboxConfig(project)

  const handle = await forkSessionLauncher(
    {
      sessionId: 'filerules-test',
      projectDir: project,
      permissions: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: {} },
      allowUnenforced: false,
      fileRules: sandboxConfig.fileRules,
      defaultFilePermissions: sandboxConfig.defaultPermissions,
    },
    () => {},
  )

  try {
    // readme.txt should be readable (default read: true, no rule overrides)
    const content = await handle.callTool('read_file', { path: join(project, 'readme.txt') })
    assert.equal(content, 'hello')

    // secret.env should be denied (fileRule says read: false)
    await assert.rejects(
      () => handle.callTool('read_file', { path: join(project, 'secret.env') }),
      /denied|not readable/i,
      'read_file on *.env should be denied by fileRules',
    )
  } finally {
    handle.stop()
    rmSync(project, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInMemoryDb() {
  let seq = 0
  const messages = []
  const sessions = []
  return {
    prepare(sql) {
      const self = this
      return {
        run(...args) {
          if (sql.includes('INSERT INTO sessions')) {
            sessions.push({ id: args[0], status: args[4] })
          } else if (sql.includes('INSERT INTO messages')) {
            messages.push({ session_id: args[0], seq: args[1], role: args[2], content: args[3] })
          } else if (sql.includes('UPDATE sessions SET status')) {
            const s = sessions.find((s) => s.id === args[args.length - 1])
            if (s) s.status = args[0]
          }
        },
        get(sql) {
          if (sql.includes('MAX(seq)')) {
            return { next_seq: messages.length }
          }
          return undefined
        },
        all() {
          return []
        },
      }
    },
    transaction(fn) {
      return fn
    },
    close() {},
  }
}

function makeEvents() {
  const emitted = []
  return {
    emitted,
    push(event, sessionId, payload) {
      emitted.push({ event, sessionId, payload })
    },
  }
}
