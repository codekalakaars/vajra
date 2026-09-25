import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'persist', 'index.js')).href
const {
  saveSession,
  loadSession,
  listSessions,
  sessionFile,
  sessionsDir,
  deriveSessionStatus,
  evidenceToRecord,
  evidenceFromRecord,
} = await import(storeUrl)

const SESSION_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

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
function summaryFixture(projectDir, over = {}) {
  return {
    sessionId: SESSION_ID,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    status: 'pending',
    phase: 'conversing',
    planTitle: 'Add parser',
    projectDir,
    done: 0,
    total: 1,
    ...over,
  }
}

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

test('save/load round-trip preserves plan, evidence and task state (P4)', t => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))

  saveSession(sessionFixture(project))
  const file = sessionFile(project, SESSION_ID)
  assert.ok(file.endsWith(join('.vajra', 'sessions', `${SESSION_ID}.json`)), file)

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

test('a successful save leaves exactly one file — tmp is renamed away', t => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))

  saveSession(sessionFixture(project))
  const names = readdirSync(sessionsDir(project))
  assert.deepEqual(names, [`${SESSION_ID}.json`])
})

test('saveSession writes via tmp + rename: a failed rename keeps the previous good file', t => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))

  saveSession(sessionFixture(project))
  const file = sessionFile(project, SESSION_ID)
  const before = readFileSync(file, 'utf-8')

  const realRename = fs.renameSync
  let sawTmp = null
  fs.renameSync = (src, dest) => {
    sawTmp = { src, dest }
    throw new Error('simulated crash before rename')
  }
  syncBuiltinESMExports()
  try {
    assert.throws(
      () => saveSession(sessionFixture(project, { createdAt: 2_000_000_000_000 })),
      /simulated crash before rename/,
    )
  } finally {
    fs.renameSync = realRename
    syncBuiltinESMExports()
  }

  assert.ok(sawTmp, 'renameSync was called with a tmp source')
  assert.notEqual(sawTmp.src, file)
  assert.match(sawTmp.src, /\.tmp$/)
  assert.equal(sawTmp.dest, file)
  // Previous good file untouched, crashed tmp cleaned up, nothing half-written.
  assert.equal(readFileSync(file, 'utf-8'), before)
  assert.deepEqual(readdirSync(sessionsDir(project)), [`${SESSION_ID}.json`])
  assert.equal(loadSession(SESSION_ID, project).createdAt, 1_700_000_000_000)
})

/** Simulate a writer that crashed between "tmp written" and "renamed". */
function crashBeforeRename(target, partialJson) {
  const script = `
    const { writeFileSync } = require('node:fs')
    writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(partialJson)})
    process.kill(process.pid, 'SIGKILL')
  `
  const result = spawnSync(process.execPath, ['-e', script])
  assert.equal(result.signal, 'SIGKILL', 'crash helper must die before renaming')
}

test('interrupted write with no previous file: tmp present, target absent', t => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))

  const target = sessionFile(project, SESSION_ID)
  fs.mkdirSync(sessionsDir(project), { recursive: true })
  const tmp = `${target}.${process.pid}.1.tmp`
  crashBeforeRename(tmp, '{"version":1,"sessionId":"0f1e')

  assert.equal(fs.existsSync(target), false)
  assert.equal(loadSession(SESSION_ID, project), null)
  assert.deepEqual(listSessions(project), [])
  assert.deepEqual(readdirSync(sessionsDir(project)), [`${SESSION_ID}.json.${process.pid}.1.tmp`])
})

test('interrupted write leaves the previous good file intact', t => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))

  saveSession(sessionFixture(project))
  const file = sessionFile(project, SESSION_ID)
  const before = readFileSync(file, 'utf-8')

  crashBeforeRename(`${file}.${process.pid}.1.tmp`, '{"version":1,"sessionId":"0f1e')

  assert.equal(readFileSync(file, 'utf-8'), before)
  const loaded = loadSession(SESSION_ID, project)
  assert.deepEqual(loaded.plan, planFixture())
  assert.deepEqual(loaded.evidence, evidenceFixture())
  // The stray tmp never surfaces as a session.
  assert.deepEqual(listSessions(project), [summaryFixture(project)])
})

test('saveSession rejects a wrong version and unsafe session ids', t => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))

  assert.throws(() => saveSession(sessionFixture(project, { version: 3 })), /Unsupported session version/)
  assert.throws(() => saveSession(sessionFixture(project, { sessionId: '../evil' })), /Invalid session id/)
  assert.throws(() => saveSession(sessionFixture(project, { sessionId: 'a/b' })), /Invalid session id/)
  assert.throws(() => saveSession(sessionFixture(project, { createdAt: NaN })), /createdAt/)
  assert.equal(fs.existsSync(sessionsDir(project)), false, 'nothing is written before validation passes')
})

test('saveSession refuses Map-valued evidence instead of silently writing {}', t => {
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
  assert.equal(fs.existsSync(sessionsDir(project)), false)
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

test('loadSession returns null for unknown ids, corrupt JSON and wrong versions', t => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))

  assert.equal(loadSession('does-not-exist', project), null)
  assert.throws(() => loadSession('../evil', project), /Invalid session id/)

  fs.mkdirSync(sessionsDir(project), { recursive: true })
  writeFileSync(join(sessionsDir(project), 'corrupt.json'), '{"version":1,')
  writeFileSync(join(sessionsDir(project), 'future.json'), JSON.stringify({ version: 99, sessionId: 'future', projectDir: project, createdAt: 1, tasks: {} }))

  assert.equal(loadSession('corrupt', project), null)
  assert.equal(loadSession('future', project), null)

  const listed = listSessions(project)
  assert.deepEqual(
    listed.map(s => s.status),
    ['corrupt', 'corrupt'],
  )
})

test('listSessions sorts newest first and derives status from tasks', t => {
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

test('loadSession and listSessions default to the current working directory', t => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const previous = process.cwd()
  try {
    process.chdir(project)
    saveSession(sessionFixture(project))
    assert.ok(loadSession(SESSION_ID))
    assert.equal(listSessions().length, 1)
    assert.equal(listSessions(join(project, 'missing-subdir')).length, 0)
  } finally {
    process.chdir(previous)
  }
})
