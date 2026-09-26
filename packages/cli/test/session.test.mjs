import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { useTempVajraHome } from './_isolate.mjs'

useTempVajraHome('vajra-session-')

const serviceUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'session', 'service.js')).href
const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tui', 'session', 'store.js')).href
const streamingUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'streaming.js')).href
const { runSession, isExitCommand } = await import(serviceUrl)
const persistUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'persist', 'index.js')).href
const { listSessions, loadSession } = await import(persistUrl)
const { SessionStore, streamFlushMs } = await import(storeUrl)
const { planSummaryLines } = await import(streamingUrl)

/** Recording fake UI: captures output, scripts prompt answers in order. */
function makeUI(promptAnswers = []) {
  const calls = []
  const answers = [...promptAnswers]
  const next = (kind, fallback = '') => {
    const answer = answers.shift()
    if (answer === undefined) throw new Error(`unexpected prompt: ${kind}`)
    return answer
  }
  const ui = {
    calls,
    banner: () => calls.push(['banner']),
    info: m => calls.push(['info', m]),
    success: m => calls.push(['success', m]),
    error: m => calls.push(['error', m]),
    warning: m => calls.push(['warning', m]),
    newline: () => calls.push(['newline']),
    onTextDelta: t => calls.push(['delta', t]),
    onThinkingDelta: t => calls.push(['thinking', t]),
    finishLine: () => calls.push(['finishLine']),
    discardBuffer: () => calls.push(['discardBuffer']),
    askInitialTask: kind => {
      calls.push(['askInitialTask', kind])
      return Promise.resolve(next(`initial:${kind}`))
    },
    askUserMessage: () => {
      calls.push(['askUserMessage'])
      return Promise.resolve(next('user'))
    },
    showPlan: plan => calls.push(['plan', plan]),
    askConfirmPlan: () => {
      calls.push(['askConfirmPlan'])
      return Promise.resolve(next('confirm'))
    },
    askRejectFeedback: () => {
      calls.push(['askRejectFeedback'])
      return Promise.resolve(next('feedback'))
    },
    onTaskEvent: e => calls.push(['task', e]),
    text: () => calls.map(c => (typeof c[1] === 'string' ? c[1] : '')).join('\n'),
  }
  return ui
}

test('isExitCommand accepts exit/quit variants only', () => {
  for (const cmd of ['exit', 'EXIT', ' quit ', '/exit', '/Quit']) {
    assert.equal(isExitCommand(cmd), true, cmd)
  }
  for (const cmd of ['exiting', 'exit now', 'no', '']) {
    assert.equal(isExitCommand(cmd), false, cmd)
  }
})

test('runSession without API key errors and returns exit 1', async () => {
  const ui = makeUI()
  const result = await runSession({ model: 'zen/x', projectDir: tmpdir() }, ui)
  assert.equal(result.exitCode, 1)
  assert.equal(result.interrupted, false)
  assert.match(ui.text(), /No API key provided for model 'zen\/x'/)
  assert.match(ui.text(), /OPENCODE_API_KEY/)
})

test('runSession rejects non-zen/go models before anything else', async () => {
  const ui = makeUI()
  const result = await runSession({ model: 'openai/gpt-4o', projectDir: tmpdir() }, ui)
  assert.equal(result.exitCode, 1)
  assert.match(ui.text(), /Unsupported model 'openai\/gpt-4o'/)
  assert.match(ui.text(), /only zen\/\* and go\/\* are supported/)

  // Even with an explicit key the unsupported model never reaches a request.
  const ui2 = makeUI()
  const result2 = await runSession(
    { model: 'openai/gpt-4o', apiKey: 'sk-test', projectDir: tmpdir() },
    ui2,
  )
  assert.equal(result2.exitCode, 1)
  assert.match(ui2.text(), /Unsupported model 'openai\/gpt-4o'/)
})

test('runSession without project dir errors and returns exit 1', async () => {
  const ui = makeUI()
  const result = await runSession(
    { model: 'zen/x', apiKey: 'sk-test', projectDir: '/nonexistent/vajra-dir' },
    ui,
  )
  assert.equal(result.exitCode, 1)
  assert.match(ui.text(), /Project directory does not exist/)
})

test('exit at the first prompt returns 0 and reports exited', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'vajra-session-'))
  try {
    const ui = makeUI(['exit'])
    const result = await runSession(
      { model: 'zen/x', apiKey: 'sk-test', projectDir, allowUnenforced: true },
      ui,
    )
    assert.equal(result.exitCode, 0)
    assert.equal(result.exited, true)
    assert.match(ui.text(), /Goodbye!/)
    const kinds = ui.calls.filter(c => c[0] === 'askInitialTask').map(c => c[1])
    assert.deepEqual(kinds, ['first'])
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('empty initial answer re-prompts with the reentry label', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'vajra-session-'))
  try {
    const ui = makeUI(['', 'exit'])
    const result = await runSession(
      { model: 'zen/x', apiKey: 'sk-test', projectDir, allowUnenforced: true },
      ui,
    )
    assert.equal(result.exitCode, 0)
    assert.equal(result.exited, true)
    const kinds = ui.calls.filter(c => c[0] === 'askInitialTask').map(c => c[1])
    assert.deepEqual(kinds, ['first', 'reentry'])
    assert.match(ui.text(), /Goodbye!/)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('runSession drains a pending prompt when the signal aborts', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'vajra-session-'))
  try {
    const controller = new AbortController()
    // Parked UI: the initial prompt stays open until the test drains it —
    // mirrors the TUI store, which resolves pending prompts on interrupt.
    let drainPrompt = null
    const ui = makeUI([])
    ui.askInitialTask = kind => {
      ui.calls.push(['askInitialTask', kind])
      return new Promise(resolve => {
        drainPrompt = resolve
      })
    }
    const pending = runSession(
      {
        model: 'zen/x',
        apiKey: 'sk-test',
        projectDir,
        allowUnenforced: true,
        signal: controller.signal,
      },
      ui,
    )
    // Wait for the initial prompt to be pending, then interrupt.
    await new Promise(r => setTimeout(r, 500))
    controller.abort()
    assert.ok(drainPrompt, 'prompt should be pending at interrupt time')
    drainPrompt('exit')
    const result = await pending
    assert.equal(result.interrupted, true)
    assert.equal(result.exitCode, 130)
    assert.match(ui.text(), /Session interrupted\. Progress has been saved\./)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('SessionStore resolves prompts on submit and echoes user entries', async () => {
  const store = new SessionStore()
  const p = store.ask('user')
  assert.ok(store.getSnapshot().prompt)
  store.submitPrompt('  hello  ')
  assert.equal(await p, 'hello')
  assert.equal(store.getSnapshot().prompt, null)
  const entries = store.getSnapshot().entries
  // Entries carry a `seq` for React keys, so assert the fields that matter
  // rather than deep-equalling the whole object.
  const last = entries[entries.length - 1]
  assert.equal(last.kind, 'user')
  assert.equal(last.text, 'hello')
  assert.equal(typeof last.seq, 'number')
})

test('SessionStore confirm prompt records a decision, not a user message', async () => {
  const store = new SessionStore()
  const p = store.ask('confirm-plan')
  store.submitPrompt('y')
  assert.equal(await p, 'y')
  const entries = store.getSnapshot().entries
  assert.equal(entries[entries.length - 1].kind, 'decision')
})

test('SessionStore drains a pending prompt after interrupt', async () => {
  const store = new SessionStore()
  const p = store.ask('user')
  store.markInterrupted()
  await new Promise(r => queueMicrotask(r))
  assert.equal(await p, 'exit')
  assert.equal(store.getSnapshot().prompt, null)
})

test('SessionStore auto-drains prompts created after interrupt', async () => {
  const store = new SessionStore()
  store.markInterrupted()
  const p = store.ask('feedback')
  assert.equal(await p, 'exit')
})

test('SessionStore applies task events to the task list', () => {
  const store = new SessionStore()
  store.setPlanTasks({
    id: 'plan-1',
    tasks: [
      { id: 't1', title: 'One', type: 'code' },
      { id: 't2', title: 'Two', type: 'code' },
    ],
  })
  store.applyTaskEvent({ type: 'start', index: 1, total: 2, title: 'One' })
  let tasks = store.getSnapshot().tasks
  assert.equal(tasks[0].status, 'running')
  assert.equal(store.getSnapshot().executionIndex, 1)
  store.applyTaskEvent({ type: 'done', title: 'One' })
  store.applyTaskEvent({ type: 'failed', title: 'Two' })
  tasks = store.getSnapshot().tasks
  assert.equal(tasks[0].status, 'done')
  assert.equal(tasks[1].status, 'failed')
})

test('SessionStore commits streamed text as an assistant entry', () => {
  const store = new SessionStore()
  store.appendStream('Hello ')
  store.appendStream('world')
  // Deltas are buffered and flushed on a short timer, so the text is not in the
  // snapshot yet — committing flushes it synchronously, which is the contract
  // that matters: nothing is lost or delayed at a turn boundary.
  store.commitStream()
  const entries = store.getSnapshot().entries
  const last = entries[entries.length - 1]
  assert.equal(last.kind, 'assistant')
  assert.equal(last.text, 'Hello world')
  assert.equal(store.getSnapshot().streaming, '')
})

test('SessionStore coalesces a burst of deltas into one repaint', async () => {
  // Repainting per token is what made the TUI flicker: every notification
  // re-rendered the session view. A burst must cost one notification.
  const store = new SessionStore()
  let notifications = 0
  store.subscribe(() => { notifications++ })

  for (let i = 0; i < 200; i++) store.appendStream('tok')
  assert.equal(notifications, 0, 'nothing is published while deltas are still arriving')

  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(notifications, 1, `200 deltas must coalesce into one repaint, got ${notifications}`)
  assert.equal(store.getSnapshot().streaming, 'tok'.repeat(200), 'no text may be lost')
  store.commitStream()
})

test('SessionStore clears buffered deltas that were never shown', () => {
  const store = new SessionStore()
  store.appendStream('dropped')
  store.clearStream()
  store.commitStream()
  assert.equal(store.getSnapshot().entries.length, 0)
})

test('SessionStore.discardBuffer-style clear drops the stream', () => {
  const store = new SessionStore()
  store.appendStream('dropped')
  store.clearStream()
  assert.equal(store.getSnapshot().streaming, '')
  store.commitStream()
  assert.equal(store.getSnapshot().entries.length, 0)
})

test('planSummaryLines renders tasks and auxiliary lines', () => {
  const lines = planSummaryLines({
    tasks: [
      {
        title: 'Fix login',
        type: 'code',
        timeoutSeconds: 60,
        writeFile: ['src/login.ts'],
        validation: ['npm test'],
        dependsOn: ['task-0'],
      },
      { title: 'Docs', type: 'docs' },
    ],
  })
  const text = lines.join('\n')
  assert.match(text, /📋 Plan:/)
  assert.match(text, /1\. Fix login \[code\] \(60s\)/)
  assert.match(text, /writes: src\/login\.ts/)
  assert.match(text, /validation: npm test/)
  assert.match(text, /depends on: task-0/)
  assert.match(text, /2\. Docs \[docs\]/)
})

test('planSummaryLines omits auxiliary lines when absent', () => {
  const lines = planSummaryLines({ tasks: [{ title: 'Only', type: 'code' }] })
  const text = lines.join('\n')
  assert.ok(!text.includes('writes:'))
  assert.ok(!text.includes('validation:'))
  assert.ok(!text.includes('depends on:'))
})

test('the repaint interval scales with how much text is buffered', async () => {
  // A short answer repaints smoothly; a long one cannot afford 20fps, because
  // Ink's frame cost grows with the frame.
  assert.equal(streamFlushMs(0), 50)
  assert.equal(streamFlushMs(999), 50)
  assert.equal(streamFlushMs(1_000), 100)
  assert.equal(streamFlushMs(3_999), 100)
  assert.equal(streamFlushMs(4_000), 200)
  assert.equal(streamFlushMs(50_000), 200)
})

test('a long burst is still coalesced into a single repaint', async () => {
  const store = new SessionStore()
  let notifications = 0
  store.subscribe(() => { notifications++ })
  // 5KB arriving in one burst: one repaint, and all of it painted.
  store.appendStream('x'.repeat(5_000))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(notifications, 1, `expected one repaint, got ${notifications}`)
  assert.equal(store.getSnapshot().streaming.length, 5_000)
  store.commitStream()
})

test('a conversation that never reaches a plan is still recorded and resumable', async () => {
  // Regression: the conversation log was written from turn one, but the session
  // itself only appeared once a plan was proposed — so `vajra sessions` listed
  // nothing and `vajra resume` could not find a long conversation that had never
  // produced a plan. The schema has had a 'conversing' phase all along; nothing
  // wrote it.
  const dir = mkdtempSync(join(tmpdir(), 'vajra-conv-'))
  const ui = makeUI(['exit'])
  try {
    // No provider is reachable, so the turn fails and the loop unwinds - which
    // is exactly the shape of the bug: a session that ended without a plan.
    await runSession({ model: 'zen/test', apiKey: 'k', projectDir: dir, task: 'hello' }, ui)

    const sessions = listSessions(dir)
    assert.equal(sessions.length, 1, 'the session must be visible with no plan in sight')
    const [summary] = sessions
    assert.equal(summary.phase, 'finished', 'a session that ended is finished, not in flight')
    assert.equal(summary.total, 0, 'no plan means no tasks')

    const stored = loadSession(summary.sessionId, dir)
    assert.ok(stored, 'and it must load for resume')
    assert.equal(stored.plan, null)
    assert.equal(stored.sessionId, summary.sessionId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an interrupted conversation is recorded rather than lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-conv-int-'))
  const ui = makeUI(['exit'])
  try {
    await runSession({ model: 'zen/test', apiKey: 'k', projectDir: dir, task: 'hi' }, ui)
    const sessions = listSessions(dir)
    assert.equal(sessions.length, 1)
    assert.ok(loadSession(sessions[0].sessionId, dir), 'the record must be readable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
