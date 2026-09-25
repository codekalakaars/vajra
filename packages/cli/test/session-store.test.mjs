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
  assert.equal(store.getSnapshot().entries.length, 0, 'no transcript growth')
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
