import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'persist', 'index.js')).href
const {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  appendMessage,
  loadMessages,
  openDb,
  closeDb,
  deriveSessionStatus,
  evidenceToRecord,
  evidenceFromRecord,
} = await import(storeUrl)

const SESSION_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

/** Each test gets a private VAJRA_HOME, so its store is its own world. */
function isolated(t, fn) {
  const home = mkdtempSync(join(tmpdir(), 'vajra-home-'))
  const previous = process.env.VAJRA_HOME
  process.env.VAJRA_HOME = home
  t.after(() => {
    try {
      closeDb()
    } catch {
      // Already closed or never opened.
    }
    if (previous === undefined) delete process.env.VAJRA_HOME
    else process.env.VAJRA_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return fn(home)
}

function makeProject() {
  return mkdtempSync(join(tmpdir(), 'vajra-persist-'))
}

function planFixture() {
  return {
    tasks: [
      {
        id: 'a',
        title: 'Add parser',
        description: 'write a parser',
        instructions: ['create src/parser.ts'],
        readFile: ['src/index.ts'],
        writeFile: ['src/parser.ts'],
        deleteFile: [],
        createDir: [],
        validation: ['npm test'],
        dependsOn: [],
        type: 'create',
      },
    ],
    independentGroups: [['a']],
    estimatedWorkers: 1,
  }
}

function evidenceFixture() {
  return {
    filesRead: { 'src/index.ts': 'export const a = 1\n', '.env.example': 'KEY=' },
    baselines: { 'a#0': 0 },
  }
}

/** listSessions() rows carry the extra v2 columns; one fixture for them all. */
function configFixture() {
  return { model: 'zen/test-model', timeoutSeconds: 300, allowUnenforced: false }
}

function sessionFixture(projectDir, over = {}) {
  return {
    version: 2,
    sessionId: SESSION_ID,
    projectDir,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    config: configFixture(),
    phase: 'conversing',
    plan: planFixture(),
    evidence: evidenceFixture(),
    tasks: { a: { status: 'pending' } },
    fileHashes: { 'src/index.ts': 'abc123' },
    summaryFingerprint: 'fp-1',
    ...over,
  }
}

/** Insert a raw row, bypassing saveSession's validation (corruption cases). */
function injectRow(row) {
  openDb()
    .prepare(
      'INSERT INTO sessions (session_id, project_dir, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)',
    )
    .run(row.sessionId, row.projectDir, row.createdAt, row.updatedAt, row.data)
}

test('save/load round-trip preserves plan, evidence and task state (P4)', t => {
  isolated(t, (home) => {
    const project = makeProject()
    t.after(() => rmSync(project, { recursive: true, force: true }))

    saveSession(sessionFixture(project))
    assert.ok(existsSync(join(home, 'vajra.db')), 'the store lives in VAJRA_HOME')

    const loaded = loadSession(SESSION_ID, project)
    assert.ok(loaded, 'session loads after save')
    assert.equal(loaded.version, 2)
    assert.equal(loaded.sessionId, SESSION_ID)
    assert.equal(loaded.projectDir, project)
    assert.deepEqual(loaded.config, configFixture())
    assert.equal(loaded.phase, 'conversing')
    assert.equal(loaded.updatedAt, 1_700_000_000_500)
    assert.deepEqual(loaded.fileHashes, { 'src/index.ts': 'abc123' })
    assert.equal(loaded.summaryFingerprint, 'fp-1')
    assert.deepEqual(loaded.plan, planFixture())
    assert.deepEqual(loaded.evidence, evidenceFixture())
    assert.deepEqual(loaded.tasks, { a: { status: 'pending' } })

    // A second save with progressed task state round-trips too (P5).
    saveSession(
      sessionFixture(project, {
        plan: null,
        evidence: null,
        tasks: { a: { status: 'done', startedAt: 5, completedAt: 9 } },
      }),
    )
    const reloaded = loadSession(SESSION_ID, project)
    assert.deepEqual(reloaded.tasks, { a: { status: 'done', startedAt: 5, completedAt: 9 } })
    assert.equal(reloaded.plan, null)
    assert.equal(reloaded.evidence, null)
  })
})

test('a re-save upserts the same row instead of fragmenting the record', t => {
  isolated(t, () => {
    const project = makeProject()
    t.after(() => rmSync(project, { recursive: true, force: true }))

    saveSession(sessionFixture(project))
    saveSession(sessionFixture(project, { updatedAt: 2_000_000_000_000, phase: 'executing' }))

    const rows = listSessions(project)
    assert.equal(rows.length, 1, 'one row, one record')
    assert.equal(rows[0].updatedAt, 2_000_000_000_000)
    assert.equal(rows[0].phase, 'executing')
  })
})

test('saveSession rejects a wrong version and unsafe session ids', t => {
  isolated(t, () => {
    const project = makeProject()
    t.after(() => rmSync(project, { recursive: true, force: true }))

    assert.throws(() => saveSession(sessionFixture(project, { version: 3 })), /Unsupported session version/)
    assert.throws(() => saveSession(sessionFixture(project, { sessionId: '../evil' })), /Invalid session id/)
    assert.throws(() => saveSession(sessionFixture(project, { sessionId: 'a/b' })), /Invalid session id/)
    assert.throws(() => saveSession(sessionFixture(project, { createdAt: NaN })), /createdAt/)
    assert.deepEqual(listSessions(project), [], 'nothing is written before validation passes')
  })
})

test('saveSession refuses Map-valued evidence instead of silently writing {}', t => {
  isolated(t, () => {
    const project = makeProject()
    t.after(() => rmSync(project, { recursive: true, force: true }))

    assert.throws(
      () =>
        saveSession(
          sessionFixture(project, {
            evidence: { filesRead: new Map(), baselines: new Map() },
          }),
        ),
      /evidenceToRecord/,
    )
    assert.deepEqual(listSessions(project), [])
  })
})

test('evidence adapters convert Maps to JSON-safe Records and back', () => {
  const maps = {
    filesRead: new Map([['src/a.ts', 'const a = 1']]),
    baselines: new Map([['a#0', 0]]),
  }
  const record = evidenceToRecord(maps)
  assert.deepEqual(record, {
    filesRead: { 'src/a.ts': 'const a = 1' },
    baselines: { 'a#0': 0 },
  })
  // Round-trips through actual JSON, which is what persistence does.
  const back = evidenceFromRecord(JSON.parse(JSON.stringify(record)))
  assert.deepEqual(back, maps)
  assert.deepEqual(evidenceFromRecord(null), { filesRead: new Map(), baselines: new Map() })
  assert.throws(() => evidenceToRecord({ filesRead: record.filesRead, baselines: record.baselines }), /Map/)
})

test('loadSession returns null for unknown ids, corrupt rows and wrong versions', t => {
  isolated(t, () => {
    const project = makeProject()
    t.after(() => rmSync(project, { recursive: true, force: true }))

    assert.equal(loadSession('does-not-exist', project), null)
    assert.throws(() => loadSession('../evil', project), /Invalid session id/)

    // Rows that could only come from a torn write or a future writer.
    injectRow({
      sessionId: 'corrupt',
      projectDir: project,
      createdAt: 1,
      updatedAt: 1,
      data: '{"version":1,',
    })
    injectRow({
      sessionId: 'future',
      projectDir: project,
      createdAt: 1,
      updatedAt: 1,
      data: JSON.stringify({ version: 99, sessionId: 'future', projectDir: project, createdAt: 1, tasks: {} }),
    })

    assert.equal(loadSession('corrupt', project), null)
    assert.equal(loadSession('future', project), null)

    const listed = listSessions(project)
    assert.deepEqual(
      listed.map(s => s.status),
      ['corrupt', 'corrupt'],
      'unparseable rows are reported, not dropped',
    )
  })
})

test('listSessions sorts newest first and derives status from tasks', t => {
  isolated(t, () => {
    const project = makeProject()
    t.after(() => rmSync(project, { recursive: true, force: true }))

    saveSession(sessionFixture(project, { sessionId: 'old', createdAt: 1_000, updatedAt: 1_000, tasks: { a: { status: 'done' } } }))
    saveSession(sessionFixture(project, { sessionId: 'new', createdAt: 9_000, updatedAt: 9_000, tasks: { a: { status: 'running', startedAt: 1 } } }))
    saveSession(sessionFixture(project, { sessionId: 'mid', createdAt: 5_000, updatedAt: 5_000, tasks: { a: { status: 'failed', error: 'boom' } } }))

    assert.deepEqual(
      listSessions(project).map(s => [s.sessionId, s.status, s.done, s.total]),
      [
        ['new', 'running', 0, 1],
        ['mid', 'failed', 0, 1],
        ['old', 'done', 1, 1],
      ],
    )

    assert.equal(deriveSessionStatus({}), 'pending')
    assert.equal(deriveSessionStatus({ a: { status: 'pending' }, b: { status: 'done' } }), 'pending')
    assert.equal(deriveSessionStatus({ a: { status: 'assigned' } }), 'running')
    assert.equal(deriveSessionStatus({ a: { status: 'running' }, b: { status: 'failed' } }), 'running')
    assert.equal(deriveSessionStatus({ a: { status: 'done' }, b: { status: 'skipped' } }), 'done')
    assert.equal(deriveSessionStatus({ a: { status: 'done' }, b: { status: 'failed' } }), 'failed')
  })
})

test('the store is global: lookup by id works from anywhere, filters still narrow', t => {
  isolated(t, () => {
    const projectA = makeProject()
    const projectB = makeProject()
    t.after(() => {
      rmSync(projectA, { recursive: true, force: true })
      rmSync(projectB, { recursive: true, force: true })
    })

    saveSession(sessionFixture(projectA))

    // No projectDir: the id is the whole address.
    assert.ok(loadSession(SESSION_ID), 'loads without being told the project')
    assert.equal(listSessions().length, 1, 'every project is listed by default')
    assert.equal(listSessions(projectB).length, 0, 'another project does not see it')
    assert.deepEqual(listSessions(projectA).map(s => s.sessionId), [SESSION_ID])
  })
})

test('append/load messages keep their order and vanish with the session', t => {
  isolated(t, () => {
    const project = makeProject()
    t.after(() => rmSync(project, { recursive: true, force: true }))

    saveSession(sessionFixture(project))
    appendMessage(SESSION_ID, project, { role: 'user', content: 'first' })
    appendMessage(SESSION_ID, project, { role: 'assistant', content: 'second' })
    appendMessage(SESSION_ID, project, { role: 'user', content: 'third' })

    assert.deepEqual(
      loadMessages(SESSION_ID).map(m => m.content),
      ['first', 'second', 'third'],
    )

    assert.equal(deleteSession(SESSION_ID), true)
    assert.equal(loadSession(SESSION_ID), null)
    assert.deepEqual(loadMessages(SESSION_ID), [], 'messages die with their session')
    assert.equal(deleteSession(SESSION_ID), false, 'second delete is a no-op')
  })
})
