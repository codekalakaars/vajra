import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const serviceUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'session', 'service.js')).href
const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tui', 'session', 'store.js')).href
const streamingUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'streaming.js')).href
const { runSession, isExitCommand } = await import(serviceUrl)
const { SessionStore } = await import(storeUrl)
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

test('runSession picks OPENROUTER_API_KEY hint for non-zen models', async () => {
  const ui = makeUI()
  const result = await runSession({ model: 'openai/gpt-4o', projectDir: tmpdir() }, ui)
  assert.equal(result.exitCode, 1)
  assert.match(ui.text(), /OPENROUTER_API_KEY/)
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
  assert.deepEqual(entries[entries.length - 1], { kind: 'user', text: 'hello' })
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
  assert.equal(store.getSnapshot().streaming, 'Hello world')
  store.commitStream()
  const entries = store.getSnapshot().entries
  assert.deepEqual(entries[entries.length - 1], { kind: 'assistant', text: 'Hello world' })
  assert.equal(store.getSnapshot().streaming, '')
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
