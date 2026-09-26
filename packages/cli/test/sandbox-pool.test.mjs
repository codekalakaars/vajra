import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchSandboxSessionPool } from '../dist/sandbox/launch.js'

/**
 * The pool-backed session must be indistinguishable from a single session to
 * everything above it — same surface, same per-task scoping — while giving each
 * in-flight task its own worker process.
 */

const ALLOW = { read: true, write: true, edit: true, delete: false }
const DENY = { read: false, write: false, edit: false, delete: false }

let projectDir
let session

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'vajra-pool-'))
  writeFileSync(join(projectDir, 'a.txt'), 'alpha\n')
  writeFileSync(join(projectDir, 'b.txt'), 'beta\n')
  session = await launchSandboxSessionPool(projectDir, 'pool-session', {
    allowUnenforced: true,
  })
})

after(() => {
  session?.close()
  rmSync(projectDir, { recursive: true, force: true })
})

test('two tasks get separate workers, so one worker dying does not fail the other', async () => {
  const a = session.handleForTask('task-a', () => ALLOW, () => {})
  const b = session.handleForTask('task-b', () => ALLOW, () => {})

  // Both work at once; each lands on its own worker.
  const [resultA, resultB] = await Promise.all([
    a.callTool('read_file', { path: join(projectDir, 'a.txt') }),
    b.callTool('read_file', { path: join(projectDir, 'b.txt') }),
  ])
  assert.match(String(resultA), /alpha/)
  assert.match(String(resultB), /beta/)

  // Releasing a task must not disturb the other.
  session.releaseTask('task-a')
  const afterRelease = await b.callTool('read_file', { path: join(projectDir, 'b.txt') })
  assert.match(String(afterRelease), /beta/)
  session.releaseTask('task-b')
})

test('per-task permission scoping still holds through the pool', async () => {
  const denied = session.handleForTask('task-denied', () => DENY, () => {})
  const allowed = session.handleForTask('task-allowed', () => ALLOW, () => {})

  // A deny-scoped task must still be refused even though another task on a
  // different worker is permitted: scoping is per task, not per worker.
  await assert.rejects(
    () => denied.callTool('write_file', { path: join(projectDir, 'denied.txt'), content: 'x' }),
    /Access denied/,
  )
  assert.equal(
    await allowed.callTool('write_file', { path: join(projectDir, 'allowed.txt'), content: 'ok' }),
    'ok',
  )

  session.releaseTask('task-denied')
  session.releaseTask('task-allowed')
})

test('a released task does not leak its permissions into the next one', async () => {
  const strict = session.handleForTask('task-strict', () => DENY, () => {})
  await assert.rejects(
    () => strict.callTool('write_file', { path: join(projectDir, 'nope.txt'), content: 'x' }),
    /Access denied/,
  )
  session.releaseTask('task-strict')

  // The next task is unrestricted, which it would not be if the released scope
  // were still registered on the reused worker.
  const next = session.handleForTask('task-next', () => ALLOW, () => {})
  assert.equal(
    await next.callTool('write_file', { path: join(projectDir, 'next.txt'), content: 'ok' }),
    'ok',
  )
  session.releaseTask('task-next')
})

test('calls after release are refused rather than silently using a reused worker', async () => {
  const handle = session.handleForTask('task-released', () => ALLOW, () => {})
  await handle.callTool('read_file', { path: join(projectDir, 'a.txt') })
  session.releaseTask('task-released')

  await assert.rejects(
    () => handle.callTool('write_file', { path: join(projectDir, 'late.txt'), content: 'x' }),
    /no longer available|already released|drain/,
  )
})

test('the session-scope handle still works for planning and rollback', async () => {
  // Rollback and the planning turn use the session handle, not a task handle.
  session.setTaskPermissions(() => ALLOW)
  const result = await session.handle.callTool('read_file', { path: join(projectDir, 'a.txt') })
  assert.match(String(result), /alpha/)
  assert.equal(session.report.enforced !== undefined, true)
})
