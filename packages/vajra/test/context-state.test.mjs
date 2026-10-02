import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * K0: the plan's structured fields have to reach the queue, because the context
 * pack is built from the queue's task and not from the plan.
 *
 * The failure this pins down is silent and total. `lower()` turns `context` into
 * `readFile` and `edits` into `instructions`, so a task that lost its structured
 * fields is still perfectly executable — it just has no anchors, no reasons and
 * no verify commands, and the Worker is handed a list of paths and a sentence.
 */

const queueUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'manager', 'taskqueue.js')).href
const { TaskQueue } = await import(queueUrl)

const PLANNED = {
  id: 't1',
  title: 'Wire the runner',
  description: 'so the suite can call it',
  context: [{ path: 'src/a.ts', reason: 'the edit site' }],
  edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = 1', change: 'Return a tuple.' }],
  verify: [{ command: 'pnpm', args: ['test'], kind: 'proves-change' }],
  instructions: ['In src/a.ts, at the text `const run = 1`: Return a tuple.'],
  readFile: ['src/a.ts'],
  writeFile: ['src/a.ts'],
  deleteFile: [],
  createDir: [],
  validation: ['pnpm test'],
  dependsOn: [],
  type: 'modify',
  successCriteria: ['pnpm test exits 0'],
  notes: 'the generated header must survive',
}

test('the queue keeps the structured fields the pack reads', () => {
  const queue = new TaskQueue('session-1', 60)
  const state = queue.addTask(PLANNED)

  assert.deepEqual(state.context, PLANNED.context)
  assert.deepEqual(state.edits, PLANNED.edits)
  assert.deepEqual(state.verify, PLANNED.verify)
  assert.deepEqual(state.successCriteria, PLANNED.successCriteria)
  assert.equal(state.notes, PLANNED.notes)
})

test('the lowered flat fields are kept too, so nothing that reads them changes', () => {
  const queue = new TaskQueue('session-1', 60)
  const state = queue.addTask(PLANNED)

  assert.deepEqual(state.readFile, ['src/a.ts'])
  assert.deepEqual(state.writeFile, ['src/a.ts'])
  assert.deepEqual(state.validation, ['pnpm test'])
})

test('a flat task gains no structured keys at all', () => {
  const queue = new TaskQueue('session-1', 60)
  const state = queue.addTask({
    id: 't2',
    title: 'Read the tree',
    description: null,
    instructions: ['look around'],
    readFile: [],
    writeFile: [],
    deleteFile: [],
    createDir: [],
    validation: [],
    dependsOn: [],
    type: 'modify',
  })

  assert.equal(state.context, undefined)
  assert.equal(state.edits, undefined)
  assert.equal(state.verify, undefined)
  assert.equal(state.successCriteria, undefined)
  assert.equal(state.notes, undefined)
})