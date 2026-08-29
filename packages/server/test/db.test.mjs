import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../dist/db/client.js'

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-server-db-'))
  return { db: openDb(join(dir, 'test.db')), dir }
}

test('schema creates all three tables and foreign keys are enforced', () => {
  const { db, dir } = scratchDb()

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((r) => r.name)
  assert.deepEqual(tables, ['messages', 'plan_steps', 'sessions'])

  // A plan_steps row referencing a nonexistent session must be rejected —
  // this is what proves `PRAGMA foreign_keys = ON` actually took effect.
  assert.throws(() =>
    db.prepare(`INSERT INTO plan_steps (session_id, step_index, title, status) VALUES (?, ?, ?, ?)`).run(
      'no-such-session',
      0,
      'step',
      'pending',
    ),
  )

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('sessions/plan_steps/messages round-trip', () => {
  const { db, dir } = scratchDb()

  db.prepare(
    `INSERT INTO sessions (id, project_dir, task, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('s1', '/tmp/project', 'do the thing', 'openrouter/some-model', 'starting', Date.now())

  db.prepare(`INSERT INTO plan_steps (session_id, step_index, title, status) VALUES (?, ?, ?, ?)`).run(
    's1',
    0,
    'first step',
    'pending',
  )

  db.prepare(
    `INSERT INTO messages (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('s1', 0, 'user', 'do the thing', Date.now())

  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get('s1')
  assert.equal(session.project_dir, '/tmp/project')

  const steps = db.prepare(`SELECT * FROM plan_steps WHERE session_id = ?`).all('s1')
  assert.equal(steps.length, 1)
  assert.equal(steps[0].title, 'first step')

  db.close()
  rmSync(dir, { recursive: true, force: true })
})
