import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchSandboxSession } from '../dist/sandbox/launch.js'

let projectDir
let session

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'vajra-sandbox-'))
  writeFileSync(join(projectDir, 'hello.txt'), 'hello world\n', 'utf-8')
  process.env.VAJRA_TEST_WORKER_LEAK = 'super-secret-worker-value'
  session = await launchSandboxSession(projectDir, 'test-session', {
    allowUnenforced: true,
    timeoutMs: 15_000,
  })
})

after(() => {
  session?.close()
  delete process.env.VAJRA_TEST_WORKER_LEAK
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

test('worker runs with the project directory as cwd', async () => {
  const result = await session.handle.callTool('run_command', {
    command: 'node -e "process.stdout.write(process.cwd())"',
    timeoutMs: 10_000,
  })
  const parsed = JSON.parse(result)
  assert.equal(parsed.exitCode, 0)
  assert.equal(parsed.stdout, projectDir)
})

test('worker does not inherit arbitrary parent environment secrets', async () => {
  const result = await session.handle.callTool('run_command', {
    command: 'node -e "process.stdout.write(process.env.VAJRA_TEST_WORKER_LEAK || \'missing\')"',
    timeoutMs: 10_000,
  })
  const parsed = JSON.parse(result)
  assert.equal(parsed.exitCode, 0)
  assert.equal(parsed.stdout, 'missing')
})

test('an unexpected worker exit rejects in-flight calls and respawns', async () => {
  const results = await Promise.allSettled([
    session.handle.callTool('run_command', {
      command: 'node -e "process.kill(process.ppid, 9)"',
      timeoutMs: 10_000,
    }),
    session.handle.callTool('run_command', {
      command: 'node -e "setTimeout(() => {}, 10000)"',
      timeoutMs: 10_000,
    }),
  ])

  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'rejected')
  assert.match(String(results[0].reason), /Sandbox worker exited/)

  const content = await session.handle.callTool('read_file', {
    path: join(projectDir, 'hello.txt'),
  })
  assert.match(String(content), /hello world/)
})

test('a worker crash does not leave a command child mutating the project', async () => {
  const marker = join(projectDir, 'orphan-after-crash.txt')
  await Promise.allSettled([
    session.handle.callTool('run_command', {
      command: `node -e "setTimeout(() => require('node:fs').writeFileSync('${marker}', 'orphan'), 500)"`,
      timeoutMs: 10_000,
    }),
    session.handle.callTool('run_command', {
      command: 'node -e "process.kill(process.ppid, 9)"',
      timeoutMs: 10_000,
    }),
  ])
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(existsSync(marker), false)
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
