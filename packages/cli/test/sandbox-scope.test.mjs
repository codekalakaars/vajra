import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchSandboxSession } from '../dist/sandbox/launch.js'

const DENY = { read: false, write: false, edit: false, delete: false }
const ALLOW = { read: true, write: true, edit: true, delete: false }

let projectDir
let session
let helloPath
let secretPath

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'vajra-scope-'))
  helloPath = join(projectDir, 'hello.txt')
  secretPath = join(projectDir, 'secret.txt')
  writeFileSync(helloPath, 'hello world\n', 'utf-8')
  writeFileSync(secretPath, 'top secret\n', 'utf-8')
  session = await launchSandboxSession(projectDir, 'scope-session', {
    allowUnenforced: true,
    timeoutMs: 15_000,
  })
})

after(() => {
  session?.close()
  if (projectDir) rmSync(projectDir, { recursive: true, force: true })
})

test('two task handles enforce different permission maps concurrently', async () => {
  const handleA = session.handleForTask(
    'task-a',
    (path) => (path === secretPath ? DENY : ALLOW),
    () => {},
  )
  const handleB = session.handleForTask(
    'task-b',
    (path) => (path === helloPath ? DENY : ALLOW),
    () => {},
  )

  const [aSecret, bSecret, aHello, bHello] = await Promise.allSettled([
    handleA.callTool('read_file', { path: secretPath }),
    handleB.callTool('read_file', { path: secretPath }),
    handleA.callTool('read_file', { path: helloPath }),
    handleB.callTool('read_file', { path: helloPath }),
  ])

  assert.equal(aSecret.status, 'rejected')
  assert.match(aSecret.reason.message, /Access denied/)
  assert.equal(bSecret.status, 'fulfilled')
  assert.match(String(bSecret.value), /top secret/)
  assert.equal(aHello.status, 'fulfilled')
  assert.match(String(aHello.value), /hello world/)
  assert.equal(bHello.status, 'rejected')
  assert.match(bHello.reason.message, /Access denied/)
})

test('mutated replies fire only the owning task hook', async () => {
  let aMutated = 0
  let bMutated = 0
  let sessionMutated = 0
  const handleA = session.handleForTask(
    'task-mut-a',
    () => ALLOW,
    () => {
      aMutated++
    },
  )
  const handleB = session.handleForTask(
    'task-mut-b',
    () => ALLOW,
    () => {
      bMutated++
    },
  )
  session.setOnMutate(() => {
    sessionMutated++
  })

  await handleA.callTool('write_file', {
    path: join(projectDir, 'a-out.txt'),
    content: 'a\n',
  })
  assert.deepEqual([aMutated, bMutated, sessionMutated], [1, 0, 0])

  await handleB.callTool('write_file', {
    path: join(projectDir, 'b-out.txt'),
    content: 'b\n',
  })
  assert.deepEqual([aMutated, bMutated, sessionMutated], [1, 1, 0])

  await session.handle.callTool('write_file', {
    path: join(projectDir, 'session-out.txt'),
    content: 's\n',
  })
  assert.deepEqual([aMutated, bMutated, sessionMutated], [1, 1, 1])

  // Non-mutating call must not fire any hook.
  await handleA.callTool('list_files', { path: projectDir })
  assert.deepEqual([aMutated, bMutated, sessionMutated], [1, 1, 1])
})

test('session setters and task scopes do not leak into each other', async () => {
  session.setTaskPermissions((path) => (path === secretPath ? DENY : ALLOW))
  const taskHandle = session.handleForTask('task-scoped', () => ALLOW, () => {})

  // handleForTask must not clobber the session-scope lookup.
  await assert.rejects(
    () => session.handle.callTool('read_file', { path: secretPath }),
    /Access denied/,
  )
  // The session setter must not clobber the task-scope lookup.
  const content = await taskHandle.callTool('read_file', { path: secretPath })
  assert.match(String(content), /top secret/)
})

test('releaseTask clears only that task scope', async () => {
  const denySecret = (path) => (path === secretPath ? DENY : ALLOW)
  const handleA = session.handleForTask('release-a', denySecret, () => {})
  const handleB = session.handleForTask('release-b', denySecret, () => {})

  await assert.rejects(
    () => handleA.callTool('read_file', { path: secretPath }),
    /Access denied/,
  )

  session.releaseTask('release-a')

  const released = await handleA.callTool('read_file', { path: secretPath })
  assert.match(String(released), /top secret/)
  await assert.rejects(
    () => handleB.callTool('read_file', { path: secretPath }),
    /Access denied/,
  )
})
