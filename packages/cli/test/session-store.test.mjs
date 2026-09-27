import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tui', 'session', 'store.js')).href
const { SessionStore } = await import(storeUrl)

const PLAN = {
  summary: 'two tasks',
  tasks: [
    { id: 'auth-mw', title: 'Add auth middleware' },
    { id: 'db-seed', title: 'Seed the database' },
  ],
}

function dev(extra = {}) {
  return { role: 'developer', ...extra }
}
function worker(taskId, title) {
  return { role: 'worker', taskId, title }
}

test('a phase opens the developer row', () => {
  const store = new SessionStore()
  store.applyAgentEvent({ type: 'phase', agent: dev(), phase: 'indexing' })
  const { developer } = store.getSnapshot()
  assert.equal(developer.phase, 'indexing')
  assert.ok(developer.since > 0)
})

test('each worker keeps its own row, keyed by task id', () => {
  const store = new SessionStore()
  store.setPlanTasks(PLAN)
  store.applyAgentEvent({
    type: 'tool-start',
    agent: worker('auth-mw', 'Add auth middleware'),
    callId: 'c1',
    tool: 'edit_file',
    summary: 'src/middleware/auth.ts',
  })
  store.applyAgentEvent({
    type: 'tool-start',
    agent: worker('db-seed', 'Seed the database'),
    callId: 'c2',
    tool: 'run_command',
    summary: 'pnpm seed',
  })

  const { tasks } = store.getSnapshot()
  assert.equal(tasks[0].activity.tool, 'edit_file')
  assert.equal(tasks[0].activity.summary, 'src/middleware/auth.ts')
  assert.equal(tasks[1].activity.tool, 'run_command')
  assert.equal(tasks[1].activity.summary, 'pnpm seed')
})

test('completed tool calls collapse into a count instead of growing the pane', () => {
  const store = new SessionStore()
  store.setPlanTasks(PLAN)
  const agent = worker('auth-mw', 'Add auth middleware')
  for (let i = 0; i < 25; i++) {
    store.applyAgentEvent({ type: 'tool-start', agent, callId: `c${i}`, tool: 'read_file', summary: 'a.ts' })
    store.applyAgentEvent({ type: 'tool-end', agent, callId: `c${i}`, tool: 'read_file', ok: true, ms: 3, detail: '1 KB' })
  }
  const row = store.getSnapshot().tasks[0]
  assert.equal(row.activity.toolCount, 25)
  assert.equal(row.activity.tool, '', 'the row stops advertising a finished call')
  // The pane stays collapsed, but the transcript keeps one bounded line per
  // call — tool history is what the scrollback viewport exists to browse.
  const toolEntries = store.getSnapshot().entries.filter(e => e.kind === 'tool')
  assert.equal(toolEntries.length, 25, 'one transcript line per call')
  assert.ok(toolEntries.every(e => e.status === 'ok' && e.expanded === false))
  assert.ok(toolEntries.every(e => e.detail === '1 KB'), 'the outcome survives the row going quiet')
})

test('a running tool entry is resolved by its tool-end', () => {
  const store = new SessionStore()
  const agent = dev()
  store.applyAgentEvent({ type: 'tool-start', agent, callId: 'c1', tool: 'edit_file', summary: 'a.ts' })
  const running = store.getSnapshot().entries.find(e => e.kind === 'tool')
  assert.equal(running.status, 'running')
  store.applyAgentEvent({ type: 'tool-end', agent, callId: 'c1', tool: 'edit_file', ok: false, ms: 7, detail: 'Error: nope' })
  const closed = store.getSnapshot().entries.find(e => e.kind === 'tool')
  assert.equal(closed.status, 'failed')
  assert.equal(closed.ms, 7)
  assert.equal(closed.detail, 'Error: nope')
})

test('expanding a tool entry flips only that entry', () => {
  const store = new SessionStore()
  const agent = dev()
  store.applyAgentEvent({ type: 'tool-start', agent, callId: 'c1', tool: 'read_file', summary: 'a.ts' })
  store.applyAgentEvent({ type: 'tool-start', agent, callId: 'c2', tool: 'read_file', summary: 'b.ts' })
  const [first, second] = store.getSnapshot().entries.filter(e => e.kind === 'tool')
  store.toggleToolEntry(first.seq)
  const entries = store.getSnapshot().entries.filter(e => e.kind === 'tool')
  assert.equal(entries[0].expanded, true)
  assert.equal(entries[1].expanded, false, 'the sibling entry must not flip')
})

test('llm usage accumulates into the footer meter', () => {
  const store = new SessionStore()
  store.applyAgentEvent({
    type: 'llm-end',
    agent: dev(),
    round: 1,
    ms: 10,
    usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
  })
  store.applyAgentEvent({
    type: 'llm-end',
    agent: dev(),
    round: 2,
    ms: 10,
    usage: { promptTokens: 1500, completionTokens: 300, totalTokens: 1800 },
  })
  const { usage } = store.getSnapshot()
  assert.equal(usage.promptTokens, 2500)
  assert.equal(usage.completionTokens, 500)
  assert.equal(usage.calls, 2)
  assert.equal(usage.lastPromptTokens, 1500, 'the meter shows the newest context size')
})

test('a warning event lands in the transcript', () => {
  const store = new SessionStore()
  store.applyAgentEvent({ type: 'warning', agent: dev(), text: 'Context compacted: 3 dropped' })
  const entry = store.getSnapshot().entries.find(e => e.kind === 'warning')
  assert.equal(entry.text, 'Context compacted: 3 dropped')
})

test('an llm round opens and then closes the row', () => {
  const store = new SessionStore()
  store.setPlanTasks(PLAN)
  const agent = worker('db-seed', 'Seed the database')
  store.applyAgentEvent({ type: 'llm-start', agent, round: 2 })
  assert.equal(store.getSnapshot().tasks[1].activity.tool, 'thinking')
  assert.equal(store.getSnapshot().tasks[1].activity.summary, 'round 2')
  store.applyAgentEvent({ type: 'llm-end', agent, round: 2, ms: 900 })
  assert.equal(store.getSnapshot().tasks[1].activity, undefined)
})

test('heartbeats re-render without changing any state', () => {
  const store = new SessionStore()
  store.setPlanTasks(PLAN)
  store.applyAgentEvent({ type: 'tool-start', agent: worker('auth-mw', 'Add auth middleware'), callId: 'c1', tool: 'read_file', summary: 'a.ts' })
  const before = store.getSnapshot()
  store.applyAgentEvent({ type: 'heartbeat', agent: worker('auth-mw', 'Add auth middleware'), elapsedMs: 800 })
  const after = store.getSnapshot()
  assert.equal(after.tick, before.tick + 1, 'a heartbeat must trigger a re-render')
  assert.deepEqual(after.tasks, before.tasks, 'but it must not disturb the rows')
})

test('an event for an unknown task is ignored rather than throwing', () => {
  const store = new SessionStore()
  store.setPlanTasks(PLAN)
  store.applyAgentEvent({ type: 'tool-start', agent: worker('ghost', 'Not in the plan'), callId: 'c1', tool: 'read_file', summary: 'x' })
  assert.equal(store.getSnapshot().tasks.length, 2)
  assert.ok(store.getSnapshot().tasks.every(t => t.activity === undefined))
})

test('subscribers are notified on every activity update', () => {
  const store = new SessionStore()
  let renders = 0
  const unsubscribe = store.subscribe(() => {
    renders++
  })
  store.setPlanTasks(PLAN)
  store.applyAgentEvent({ type: 'phase', agent: dev(), phase: 'planning' })
  store.applyAgentEvent({ type: 'heartbeat', agent: dev(), elapsedMs: 750 })
  assert.ok(renders >= 3)
  unsubscribe()
  const after = renders
  store.applyAgentEvent({ type: 'phase', agent: dev(), phase: 'executing' })
  assert.equal(renders, after, 'unsubscribe really unsubscribes')
})

test('the store carries the live settings the header displays', () => {
  const store = new SessionStore({ model: 'zen/mimo-v2.5-free', projectDir: '/srv/app' })
  assert.equal(store.getSnapshot().model, 'zen/mimo-v2.5-free')
  assert.equal(store.getSnapshot().projectDir, '/srv/app')
  store.setSettings({ model: 'go/kimi-k3' })
  store.setSettings({ projectDir: '/srv/other' })
  const snap = store.getSnapshot()
  assert.equal(snap.model, 'go/kimi-k3')
  assert.equal(snap.projectDir, '/srv/other')
})

test('a fresh store starts un-interrupted, and the flag clears between runs', () => {
  const store = new SessionStore()
  assert.equal(store.getSnapshot().interrupted, false)
  store.markInterrupted()
  assert.equal(store.getSnapshot().interrupted, true)
  store.resetInterrupted()
  assert.equal(store.getSnapshot().interrupted, false)
})
