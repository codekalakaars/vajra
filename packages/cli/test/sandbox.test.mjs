import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchSandboxSession } from '../dist/sandbox/launch.js'

let projectDir
let session

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'vajra-sandbox-'))
  writeFileSync(join(projectDir, 'hello.txt'), 'hello world\n', 'utf-8')
  session = await launchSandboxSession(projectDir, 'test-session', {
    allowUnenforced: true,
    timeoutMs: 15_000,
  })
})

after(() => {
  session?.close()
  if (projectDir) rmSync(projectDir, { recursive: true, force: true })
})

test('reports sandbox status before any tool call', () => {
  assert.ok(session.report)
  assert.equal(typeof session.report.enforced, 'boolean')
  assert.equal(typeof session.report.mechanism, 'string')
  assert.ok(Array.isArray(session.report.warnings))
})

test('read_file round-trips over IPC', async () => {
  const content = await session.handle.callTool('read_file', {
    path: join(projectDir, 'hello.txt'),
  })
  assert.match(content, /hello world/)
})

test('parent enforces task permissions before forwarding', async () => {
  const deniedPath = join(projectDir, 'secret.txt')
  session.setTaskPermissions((path) => {
    if (path.endsWith('secret.txt')) {
      return { read: false, write: false, edit: false, delete: false }
    }
    return { read: true, write: true, edit: true, delete: false }
  })

  await assert.rejects(
    () => session.handle.callTool('read_file', { path: deniedPath }),
    /Access denied/,
  )

  session.setTaskPermissions(() => ({ read: true, write: true, edit: true, delete: false }))
})

test('mutating tools fire onMutate in the parent', async () => {
  let mutated = 0
  session.setOnMutate(() => {
    mutated++
  })

  const result = await session.handle.callTool('write_file', {
    path: join(projectDir, 'out.txt'),
    content: 'written\n',
  })
  assert.equal(result, 'ok')
  assert.equal(mutated, 1)

  // Non-mutating call must not fire again.
  await session.handle.callTool('list_files', { path: projectDir })
  assert.equal(mutated, 1)
})

test('unknown tool returns an error string (not a crash)', async () => {
  const result = await session.handle.callTool('not_a_tool', {})
  assert.match(String(result), /Unknown tool/)
})
