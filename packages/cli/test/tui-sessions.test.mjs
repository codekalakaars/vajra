import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * The TUI menu is a terminal app, so what is testable here is the contract it
 * depends on: that sessions for a project are discoverable in a stable order,
 * and that a chosen session id is the one the resume path is given. The screen
 * itself is exercised by running the TUI.
 */

const persistUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'persist', 'index.js')).href
const { saveSession, listSessions, loadSession, latestSession, deleteSession } =
  await import(persistUrl)

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-sessions-'))
  mkdirSync(join(dir, '.vajra', 'sessions'), { recursive: true })
  return dir
}

function record(dir, { id, updatedAt, phase = 'executing', done = 1, total = 3, title = 'Add auth' }) {
  const tasks = {}
  for (let i = 0; i < total; i++) {
    tasks[`t${i}`] = { status: i < done ? 'done' : 'pending' }
  }
  saveSession(
    {
      version: 2,
      sessionId: id,
      projectDir: dir,
      createdAt: updatedAt,
      updatedAt,
      config: { model: 'zen/test', timeoutSeconds: 300, allowUnenforced: false },
      phase,
      // planTitle is derived from the first task, which is what the CLI shows too.
      plan: { summary: title, tasks: [{ id: 'first', title }] },
      evidence: null,
      tasks,
      baselines: {},
      fileHashes: {},
      summaryFingerprint: null,
    },
    dir,
  )
}

test('the sessions screen has something to list for a project that has run', t => {
  const dir = makeProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.deepEqual(listSessions(dir), [], 'a fresh project lists nothing')

  record(dir, { id: 'aaaaaaaa-1111-2222-3333-444444444444', updatedAt: Date.now() - 1000 })
  record(dir, {
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    updatedAt: Date.now() - 90_000,
    done: 3,
    title: 'Fix parser',
  })

  const list = listSessions(dir)
  assert.equal(list.length, 2)
  // Newest first, so the row under the cursor is the one Enter resumes — the
  // b-session was written 90s ago, the a-session 1s ago.
  assert.deepEqual(
    list.map(e => e.sessionId.slice(0, 8)),
    ['aaaaaaaa', 'bbbbbbbb'],
  )
  for (const entry of list) {
    assert.equal(entry.sessionId.length >= 8, true, 'the screen shows an 8-char id')
    assert.equal(typeof entry.phase, 'string')
    assert.equal(typeof entry.total, 'number')
    assert.equal(entry.projectDir, dir)
  }
})

test('a chosen id round-trips, so Enter resumes the row that was highlighted', t => {
  const dir = makeProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  record(dir, { id: 'cccccccc-1111-2222-3333-444444444444', updatedAt: Date.now() })

  const [summary] = listSessions(dir)
  // The screen slices to 8 characters for display but must resume the full id.
  const displayed = summary.sessionId.slice(0, 8)
  const loaded = loadSession(summary.sessionId, dir)
  assert.ok(loaded, 'the full id must load')
  assert.equal(loaded.sessionId.startsWith(displayed), true)
  assert.equal(latestSession(dir)?.sessionId, summary.sessionId)
})

test('progress and phase reach the list, so the columns are not blank', t => {
  const dir = makeProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  record(dir, { id: 'dddddddd-1111-2222-3333-444444444444', updatedAt: Date.now(), done: 2, total: 4, phase: 'awaiting-approval' })

  const [entry] = listSessions(dir)
  assert.equal(entry.done, 2)
  assert.equal(entry.total, 4)
  assert.equal(entry.phase, 'awaiting-approval')
  assert.equal(entry.planTitle, 'Add auth')
})

test('the remove key deletes exactly the highlighted session', t => {
  const dir = makeProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  record(dir, { id: 'eeeeeeee-1111-2222-3333-444444444444', updatedAt: Date.now() - 1000 })
  record(dir, { id: 'ffffffff-1111-2222-3333-444444444444', updatedAt: Date.now() })

  const [newest, older] = listSessions(dir)
  assert.equal(newest.sessionId.startsWith('ffffffff'), true)

  assert.equal(deleteSession(newest.sessionId, dir), true)
  const left = listSessions(dir)
  assert.equal(left.length, 1)
  assert.equal(left[0].sessionId, older.sessionId, 'the other session survives')
  assert.equal(deleteSession(newest.sessionId, dir), false, 'removing twice reports nothing to remove')
})
