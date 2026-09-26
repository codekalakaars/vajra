import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { isolateEachTest } from './_isolate.mjs'

isolateEachTest('vajra-resume-')

const root = join(import.meta.dirname, '..', 'dist')
const {
  SESSION_SCHEMA_VERSION,
  DIRECTORY_FILE_HASH,
  MISSING_FILE_HASH,
  appendMessage,
  deleteSession,
  latestSession,
  listSessions,
  loadMessages,
  loadSession,
  saveSession,
  hashFile,
  openDb,
  repoFingerprint,
  loadSummaryIndexCache,
  saveSummaryIndexCache,
} = await import(pathToFileURL(join(root, 'persist', 'index.js')).href)
const {
  assessStaleness,
  blocksAutomaticResume,
  describeVerdict,
  planResume,
} = await import(pathToFileURL(join(root, 'session', 'resume.js')).href)

function project(prefix = 'vajra-resume-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

const PLAN = {
  tasks: [
    {
      id: 't1',
      title: 'Write one.txt',
      description: null,
      instructions: [],
      readFile: [],
      writeFile: ['one.txt'],
      deleteFile: [],
      createDir: [],
      validation: [],
      dependsOn: [],
      type: 'create',
    },
    {
      id: 't2',
      title: 'Write two.txt',
      description: null,
      instructions: [],
      readFile: [],
      writeFile: ['two.txt'],
      deleteFile: [],
      createDir: [],
      validation: [],
      dependsOn: [],
      type: 'create',
    },
  ],
  independentGroups: [['t1', 't2']],
  estimatedWorkers: 2,
}

function makeSession(projectDir, over = {}) {
  const written = ['one.txt', 'two.txt']
  for (const f of written) writeFileSync(join(projectDir, f), 'original\n', 'utf-8')
  const fileHashes = Object.fromEntries(
    written.map(f => [f, hashFile(join(projectDir, f))]),
  )
  return {
    version: SESSION_SCHEMA_VERSION,
    sessionId: 'sess-1',
    projectDir,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    config: { model: 'zen/test-model', timeoutSeconds: 300, allowUnenforced: false },
    phase: 'executing',
    plan: PLAN,
    evidence: null,
    tasks: {
      t1: { status: 'done', startedAt: 1, completedAt: 2 },
      t2: { status: 'pending' },
    },
    fileHashes,
    summaryFingerprint: null,
    ...over,
  }
}

// --- schema v2 ------------------------------------------------------------

test('v2 records the config, phase and hashes a resume must reproduce', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  saveSession(makeSession(dir))

  const loaded = loadSession('sess-1', dir)
  assert.equal(loaded.version, 2)
  assert.equal(loaded.phase, 'executing')
  assert.equal(loaded.config.model, 'zen/test-model')
  assert.equal(loaded.config.timeoutSeconds, 300)
  assert.equal(loaded.config.allowUnenforced, false)
  assert.equal(Object.keys(loaded.fileHashes).length, 2)
})

test('a v1 record still loads and migrates forward', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A v1 payload could arrive from an old export; the store keeps it readable.
  openDb()
    .prepare(
      'INSERT INTO sessions (session_id, project_dir, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      'legacy',
      dir,
      1_700_000_000_000,
      1_700_000_000_000,
      JSON.stringify({
        version: 1,
        sessionId: 'legacy',
        projectDir: dir,
        createdAt: 1_700_000_000_000,
        plan: PLAN,
        evidence: null,
        tasks: { t1: { status: 'done' } },
      }),
    )

  const loaded = loadSession('legacy', dir)
  assert.ok(loaded, 'a v1 record must not become unreadable')
  assert.equal(loaded.version, 2)
  assert.equal(loaded.updatedAt, loaded.createdAt, 'updatedAt falls back to createdAt')
  assert.equal(loaded.phase, 'awaiting-approval', 'a saved plan means it was awaiting approval')
  assert.deepEqual(loaded.config, { model: '', timeoutSeconds: 300, allowUnenforced: false })
  assert.deepEqual(loaded.fileHashes, {})
})

test('the conversation is an append-only log beside the metadata', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  saveSession(makeSession(dir))
  appendMessage('sess-1', dir, { role: 'user', content: 'do the thing' })
  appendMessage('sess-1', dir, { role: 'assistant', content: 'on it' })

  const messages = loadMessages('sess-1', dir)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, 'do the thing')

  // The log is not listed as a session of its own.
  assert.deepEqual(listSessions(dir).map(s => s.sessionId), ['sess-1'])
})

test('a truncated trailing line is ignored, not resurrected', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  saveSession(makeSession(dir))
  appendMessage('sess-1', dir, { role: 'user', content: 'first' })
  // Simulate a crash mid-write: a row whose payload never got a full JSON value.
  openDb()
    .prepare('INSERT INTO messages (session_id, seq, payload) VALUES (?, ?, ?)')
    .run('sess-1', 2, '{"role":"assis')

  const messages = loadMessages('sess-1', dir)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'first')
})

// --- the staleness gate ---------------------------------------------------

test('an unchanged tree resumes freely', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir)
  saveSession(session)

  const report = assessStaleness(session, dir)
  assert.equal(report.verdict.kind, 'clean')
  assert.equal(blocksAutomaticResume(report.verdict), false)
})

test("a done task's file changed: report it, never roll it back", t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir)
  // The user hand-edited finished work.
  writeFileSync(join(dir, 'one.txt'), 'the user changed this\n', 'utf-8')

  const report = assessStaleness(session, dir)
  assert.equal(report.verdict.kind, 'user-edited')
  assert.deepEqual(report.verdict.paths, ['one.txt'])
  assert.match(describeVerdict(report), /never rolled back/)
  // Still blocks: the user has to see it before we continue.
  assert.equal(blocksAutomaticResume(report.verdict), true)
})

test("a pending task's input changed: needs-replan, not a blind replay", t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir)
  // two.txt belongs to the still-pending task t2.
  writeFileSync(join(dir, 'two.txt'), 'moved under us\n', 'utf-8')

  const report = assessStaleness(session, dir)
  assert.equal(report.verdict.kind, 'needs-replan')
  assert.deepEqual(report.verdict.paths, ['two.txt'])

  const plan = planResume(session, { projectDir: dir })
  assert.deepEqual(plan.pending, [], 'a suspect plan re-runs nothing')
  assert.equal(plan.phase, 'conversing', 'control goes back to the Developer')
})

test('a task interrupted mid-edit offers a rollback, and only on request', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir, {
    tasks: {
      t1: { status: 'running', startedAt: 1, baselines: { 'one.txt': 'original\n' } },
      t2: { status: 'pending' },
    },
  })
  writeFileSync(join(dir, 'one.txt'), 'half written\n', 'utf-8')

  const report = assessStaleness(session, dir)
  assert.equal(report.verdict.kind, 'rollback-offered')
  assert.deepEqual(report.verdict.taskIds, ['t1'])

  // Not offered -> not taken.
  const withoutConsent = planResume(session, { projectDir: dir })
  assert.deepEqual(withoutConsent.rollbackTaskIds, [])
  // Explicit consent -> named, and only for the interrupted task.
  const withConsent = planResume(session, { projectDir: dir, rollbackTaskIds: ['t1', 't2'] })
  assert.deepEqual(withConsent.rollbackTaskIds, ['t1'])
})

test('a deleted file is reported rather than treated as unchanged', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir)
  rmSync(join(dir, 'one.txt'))

  const report = assessStaleness(session, dir)
  assert.equal(report.verdict.kind, 'files-missing')
  assert.deepEqual(report.verdict.paths, ['one.txt'])
})

test('directory state is tracked separately from missing files', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir, {
    fileHashes: { 'one.txt': DIRECTORY_FILE_HASH },
  })
  rmSync(join(dir, 'one.txt'))
  mkdirSync(join(dir, 'one.txt'))
  assert.equal(assessStaleness(session, dir).verdict.kind, 'clean')
  rmSync(join(dir, 'one.txt'), { recursive: true })
  assert.equal(assessStaleness(session, dir).verdict.kind, 'files-missing')
})

test('a missing recorded path stays stable and recreation is detected', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir, {
    fileHashes: { 'one.txt': MISSING_FILE_HASH },
  })
  rmSync(join(dir, 'one.txt'))

  assert.equal(assessStaleness(session, dir).verdict.kind, 'clean')
  writeFileSync(join(dir, 'one.txt'), 'recreated\n', 'utf-8')
  const report = assessStaleness(session, dir)
  assert.equal(report.verdict.kind, 'user-edited')
  assert.deepEqual(report.verdict.paths, ['one.txt'])
})

// --- the four resume points ----------------------------------------------

test('resume point 1: mid-conversation re-runs nothing and re-plans', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir, { phase: 'conversing', plan: null, tasks: {} })
  const plan = planResume(session, { projectDir: dir, assumeFresh: true })
  assert.equal(plan.phase, 'conversing')
  assert.deepEqual(plan.pending, [])
  assert.equal(plan.restoreMessages, true)
  assert.equal(plan.reapprove, false)
})

test('resume point 2: an unapproved plan is re-presented, not re-derived', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir, {
    phase: 'awaiting-approval',
    tasks: { t1: { status: 'pending' }, t2: { status: 'pending' } },
  })
  const plan = planResume(session, { projectDir: dir, assumeFresh: true })
  assert.equal(plan.reapprove, true)
  assert.equal(plan.phase, 'awaiting-approval')
  assert.deepEqual(plan.pending.sort(), ['t1', 't2'])
})

test('resume point 3: mid-execution re-runs only what did not finish', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir)
  const plan = planResume(session, { projectDir: dir, assumeFresh: true })
  assert.deepEqual(plan.completed, ['t1'])
  assert.deepEqual(plan.pending, ['t2'])
})

test('resume point 4: a finished session is read-only history', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir, {
    phase: 'finished',
    tasks: { t1: { status: 'done' }, t2: { status: 'done' } },
  })
  const plan = planResume(session, { projectDir: dir, assumeFresh: true })
  assert.deepEqual(plan.pending, [])
  assert.deepEqual(plan.completed.sort(), ['t1', 't2'])
  assert.equal(plan.reapprove, false)
})

test('force skips the gate but only when asked', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const session = makeSession(dir)
  writeFileSync(join(dir, 'one.txt'), 'changed\n', 'utf-8')

  assert.equal(blocksAutomaticResume(assessStaleness(session, dir).verdict), true)
  const forced = planResume(session, { projectDir: dir, assumeFresh: true })
  assert.equal(blocksAutomaticResume(forced.staleness.verdict), false)
})

// --- listing and removal -------------------------------------------------

test('sessions list newest first with progress and phase', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  saveSession(makeSession(dir, { sessionId: 'a', updatedAt: 1_000 }))
  saveSession(makeSession(dir, { sessionId: 'b', updatedAt: 9_000, phase: 'finished' }))

  const list = listSessions(dir)
  assert.deepEqual(list.map(s => s.sessionId), ['b', 'a'])
  assert.equal(list[0].phase, 'finished')
  assert.equal(list[0].done, 1)
  assert.equal(list[0].total, 2)
  assert.equal(latestSession(dir).sessionId, 'b')
})

test('sessions rm removes both the record and its transcript', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  saveSession(makeSession(dir))
  appendMessage('sess-1', dir, { role: 'user', content: 'hello' })

  assert.equal(deleteSession('sess-1', dir), true)
  assert.equal(loadSession('sess-1', dir), null)
  assert.deepEqual(loadMessages('sess-1', dir), [])
  assert.equal(deleteSession('sess-1', dir), false, 'removing twice is not an error')
})

// --- index cache ---------------------------------------------------------

test('an unchanged repo reuses the cached summary index', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf-8')

  const fingerprint = repoFingerprint(dir)
  saveSummaryIndexCache(dir, {
    version: 1,
    fingerprint,
    createdAt: 1,
    entries: [{ path: 'a.ts', symbols: ['a'], preview: 'x', lineCount: 1, importCount: 0, exportCount: 1 }],
  })

  const cached = loadSummaryIndexCache(dir, fingerprint)
  assert.ok(cached, 'a matching fingerprint returns the cache')
  assert.equal(cached.entries.length, 1)
  // A different fingerprint (the tree changed) misses rather than lying.
  assert.equal(loadSummaryIndexCache(dir, 'other-fingerprint'), null)
})

test('a corrupt index cache is a miss, not a crash', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.vajra', 'index'), { recursive: true })
  writeFileSync(join(dir, '.vajra', 'index', 'fp.json'), '{not json', 'utf-8')
  assert.equal(loadSummaryIndexCache(dir, 'fp'), null)
})

test('the fingerprint tracks a content change', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf-8')
  const before = repoFingerprint(dir)
  writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n', 'utf-8')
  assert.notEqual(repoFingerprint(dir), before, 'a new file must change the fingerprint')
})

test('a saved session survives a full round-trip through the index cache', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  saveSession(makeSession(dir))
  appendMessage('sess-1', dir, { role: 'user', content: 'go' })
  assert.ok(loadSession('sess-1', dir), 'the record round-trips through the store')
  assert.equal(loadSession('sess-1', dir).plan.tasks.length, 2)
  assert.equal(loadMessages('sess-1', dir).length, 1)
})

test('a resume continues the same record instead of fragmenting it', t => {
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  saveSession(makeSession(dir))
  appendMessage('sess-1', dir, { role: 'user', content: 'first attempt' })

  // What the session writes while resuming: the id it inherited.
  saveSession(makeSession(dir, { sessionId: 'sess-1', phase: 'finished' }))
  appendMessage('sess-1', dir, { role: 'user', content: 'second attempt' })

  assert.equal(listSessions(dir).length, 1, 'one record, not two')
  const messages = loadMessages('sess-1', dir)
  assert.deepEqual(messages.map(m => m.content), ['first attempt', 'second attempt'])
})

// --- end to end through runSession ---------------------------------------

test('a mid-execution resume re-runs only the unfinished task', async t => {
  const { runSession } = await import(pathToFileURL(join(root, 'session', 'service.js')).href)
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // One task already done, one outstanding.
  const plan = {
    tasks: [
      { id: 'done-1', title: 'Write one.txt', description: null, instructions: [], readFile: [], writeFile: ['one.txt'], deleteFile: [], createDir: [], validation: [], dependsOn: [], type: 'create' },
      { id: 'todo-1', title: 'Write two.txt', description: null, instructions: [], readFile: [], writeFile: ['two.txt'], deleteFile: [], createDir: [], validation: [], dependsOn: [], type: 'create' },
    ],
    independentGroups: [['done-1', 'todo-1']],
    estimatedWorkers: 2,
  }
  writeFileSync(join(dir, 'one.txt'), 'already written\n', 'utf-8')
  saveSession(makeSession(dir, { phase: 'executing', plan, tasks: { 'done-1': { status: 'done' }, 'todo-1': { status: 'pending' } } }))

  const calls = []
  const ui = {
    calls,
    banner: () => {}, info: () => {}, success: () => {}, error: m => calls.push(['error', m]),
    warning: () => {}, newline: () => {}, onTextDelta: () => {}, onThinkingDelta: () => {},
    finishLine: () => {}, discardBuffer: () => {},
    askInitialTask: () => { throw new Error('should not prompt on resume') },
    askUserMessage: () => { throw new Error('should not prompt on resume') },
    showPlan: () => {}, askConfirmPlan: () => { throw new Error('should not prompt on resume') },
    askRejectFeedback: () => { throw new Error('should not prompt on resume') },
    onTaskEvent: e => calls.push(['task', e.type, e.title]),
    onAgentEvent: () => {},
    text: () => calls.map(c => c.join(' ')).join('\n'),
  }

  // Hermetic: the worker never reaches a real provider.
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: 's', object: 'chat.completion.chunk', created: 0, model: 'm',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
        })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const result = await runSession(
    {
      task: undefined,
      model: 'zen/test-model',
      apiKey: 'sk-test',
      projectDir: dir,
      autoConfirm: true,
      allowUnenforced: true,
      resumeFrom: 'sess-1',
      force: true,
    },
    ui,
  )

  const started = calls.filter(c => c[0] === 'task' && c[1] === 'start').map(c => c[2])
  const failed = calls.filter(c => c[0] === 'task' && c[1] === 'failed').map(c => c[2])
  assert.equal(result.exitCode, 0, ui.text())
  // The completed task is never re-run; the pending one is.
  assert.ok(!started.includes('Write one.txt'), `re-ran a completed task: ${started}`)
  assert.deepEqual(started, ['Write two.txt'])
  assert.deepEqual(failed, [])
  assert.deepEqual(
    calls.filter(c => c[0] === 'task' && c[1] === 'done').map(c => c[2]),
    ['Write two.txt'],
  )
  // And it stayed one record.
  assert.equal(listSessions(dir).length, 1)
})

test('a conversational resume prompts first instead of sending an empty turn', async t => {
  const { runSession } = await import(pathToFileURL(join(root, 'session', 'service.js')).href)
  const dir = project()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  saveSession(makeSession(dir, { phase: 'conversing', plan: null, tasks: {} }))
  appendMessage('sess-1', dir, { role: 'user', content: 'earlier question' })
  appendMessage('sess-1', dir, { role: 'assistant', content: 'earlier answer' })

  // The bug: resume skipped the prompt and fired turn 1 with userMessage '',
  // so the model answered nothing and an empty user turn hit the transcript.
  const answers = ['keep going', 'exit']
  const events = []
  const calls = []
  const ui = {
    calls,
    banner: () => {}, info: () => {}, success: () => {}, error: m => calls.push(['error', m]),
    warning: () => {}, newline: () => {}, onTextDelta: () => {}, onThinkingDelta: () => {},
    finishLine: () => {}, discardBuffer: () => {},
    askInitialTask: () => { throw new Error('resume must not ask for an initial task') },
    askUserMessage: () => { events.push('prompt'); return answers.shift() ?? 'exit' },
    showPlan: () => {},
    askConfirmPlan: () => { throw new Error('no plan expected') },
    askRejectFeedback: () => { throw new Error('no plan expected') },
    onTaskEvent: () => {}, onAgentEvent: () => {},
    text: () => calls.map(c => c.join(' ')).join('\n'),
  }

  const bodies = []
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async (_url, init) => {
    events.push('fetch')
    bodies.push(JSON.parse(init.body))
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: 's', object: 'chat.completion.chunk', created: 0, model: 'm',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'okay' }, finish_reason: null }],
        })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const result = await runSession(
    {
      task: undefined,
      model: 'zen/test-model',
      apiKey: 'sk-test',
      projectDir: dir,
      autoConfirm: true,
      allowUnenforced: true,
      resumeFrom: 'sess-1',
      force: true,
    },
    ui,
  )

  assert.equal(result.exitCode, 0, ui.text())
  assert.equal(events[0], 'prompt', 'the user is asked before any model call')
  assert.ok(bodies.length >= 1, 'the model is called after the prompt')
  for (const body of bodies) {
    for (const m of body.messages) {
      if (m.role === 'user') {
        assert.ok(
          (m.content ?? '').trim().length > 0,
          `empty user turn sent to the model: ${JSON.stringify(body.messages)}`,
        )
      }
    }
  }
  const recorded = loadMessages('sess-1', dir)
  assert.ok(
    !recorded.some(m => m.role === 'user' && !(m.content ?? '').trim()),
    'no empty user message is recorded',
  )
})
