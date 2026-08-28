import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../dist/index.js'

function scratchDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-server-'))
  return { dbPath: join(dir, 'test.db'), dir }
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function call(ws, method, params) {
  const id = Math.random().toString(36).slice(2)
  return new Promise((resolve, reject) => {
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString())
      if (msg.kind === 'rpc-result' && msg.id === id) {
        ws.off('message', onMessage)
        msg.ok ? resolve(msg.result) : reject(new Error(msg.error.message))
      }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
  })
}

function waitForEvent(ws, eventName) {
  return new Promise((resolve) => {
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString())
      if (msg.kind === 'event' && msg.event === eventName) {
        ws.off('message', onMessage)
        resolve(msg)
      }
    }
    ws.on('message', onMessage)
  })
}

test('project.scan and permissions round-trip over a real WS connection', async () => {
  const { dbPath, dir: dbDir } = scratchDbPath()
  const projectDir = mkdtempSync(join(tmpdir(), 'vajra-project-'))
  writeFileSync(join(projectDir, 'app.js'), '')

  const server = await startServer({ dbPath })
  const ws = await connect(server.port)

  try {
    const entries = await call(ws, 'project.scan', { projectDir })
    assert.ok(entries.some((e) => e.name === 'app.js'))

    const defaults = await call(ws, 'project.loadPermissions', { projectDir })
    assert.equal(defaults.default.read, true)
    assert.equal(defaults.default.write, false)

    defaults.files['app.js'] = { read: true, write: true, edit: true, delete: false }
    const saved = await call(ws, 'project.savePermissions', { projectDir, config: defaults })
    assert.deepEqual(saved, { ok: true })

    const reloaded = await call(ws, 'project.loadPermissions', { projectDir })
    assert.equal(reloaded.files['app.js'].write, true)
  } finally {
    ws.close()
    await server.close()
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  }
})

test('an unknown RPC method returns a clean error, not a crash', async () => {
  const { dbPath, dir } = scratchDbPath()
  const server = await startServer({ dbPath })
  const ws = await connect(server.port)

  try {
    await assert.rejects(() => call(ws, 'does.not.exist', {}), /Unknown method/)
  } finally {
    ws.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session.create fails closed when no launcher is configured yet', async () => {
  // This is the security-relevant case for this slice: with no worker/sandbox
  // implementation wired in, a session must come back `failed`, never
  // `running` — there is no path in this slice where an agent could execute
  // unsandboxed by omission.
  const { dbPath, dir } = scratchDbPath()
  const server = await startServer({ dbPath })
  const ws = await connect(server.port)

  try {
    const permissions = await call(ws, 'project.loadPermissions', { projectDir: dir })
    const failedEvent = waitForEvent(ws, 'session.failed')

    const { sessionId } = await call(ws, 'session.create', {
      projectDir: dir,
      permissions,
      task: 'do something',
      model: 'openrouter/some-model',
    })
    assert.equal(typeof sessionId, 'string')

    const failure = await failedEvent
    assert.match(failure.payload.message, /not implemented/)

    const attached = await call(ws, 'session.attach', { sessionId })
    assert.equal(attached.session.status, 'failed')
    assert.equal(attached.sandbox, null)
    assert.ok(Array.isArray(attached.messages))
    assert.equal(attached.messages.length, 0)
    assert.equal(attached.activeStep, null)
  } finally {
    ws.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session.list reflects created sessions', async () => {
  const { dbPath, dir } = scratchDbPath()
  const server = await startServer({ dbPath })
  const ws = await connect(server.port)

  try {
    const permissions = await call(ws, 'project.loadPermissions', { projectDir: dir })
    await call(ws, 'session.create', { projectDir: dir, permissions, task: 'a task', model: 'm' })

    const sessions = await call(ws, 'session.list', {})
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].task, 'a task')
    assert.equal(sessions[0].status, 'failed')
  } finally {
    ws.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
