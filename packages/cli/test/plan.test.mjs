import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const developerUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'agent', 'developer.js')).href
const { parseProposePlanArgs } = await import(developerUrl)

test('dependencies survive a valid plan round-trip', () => {
  const result = parseProposePlanArgs({
    tasks: [
      {
        id: 'a',
        title: 'Create module',
        description: 'first',
        writeFile: ['src/a.ts'],
      },
      {
        id: 'b',
        title: 'Wire module',
        description: 'second',
        dependsOn: ['a'],
        writeFile: ['src/main.ts'],
      },
    ],
    summary: 'test plan',
  })

  assert.equal(result.ok, true)
  const ids = result.plan.tasks.map(t => t.id)
  assert.deepEqual(ids, ['a', 'b'])
  assert.deepEqual(result.plan.tasks[1].dependsOn, ['a'])
  // Waves: a alone, then b
  assert.deepEqual(result.plan.independentGroups, [['a'], ['b']])
  assert.equal(result.plan.estimatedWorkers, 1)
})

test('model-supplied ids are required (fallback task-N only when absent)', () => {
  const result = parseProposePlanArgs({
    tasks: [
      { id: '  custom-id  ', title: 't', description: 'd' },
      { title: 'no id', description: 'd' },
    ],
    summary: 's',
  })
  assert.equal(result.ok, true)
  assert.equal(result.plan.tasks[0].id, 'custom-id')
  assert.equal(result.plan.tasks[1].id, 'task-2')
})

test('duplicate task ids produce a tool error', () => {
  const result = parseProposePlanArgs({
    tasks: [
      { id: 'dup', title: 'one', description: 'd' },
      { id: 'dup', title: 'two', description: 'd' },
    ],
    summary: 's',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /Duplicate task id/)
})

test('unknown dependsOn produces a tool error (not silent filtering)', () => {
  const result = parseProposePlanArgs({
    tasks: [
      { id: 'a', title: 'one', description: 'd' },
      { id: 'b', title: 'two', description: 'd', dependsOn: ['ghost'] },
    ],
    summary: 's',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown task 'ghost'/)
})

test('empty plan is rejected', () => {
  const result = parseProposePlanArgs({ tasks: [], summary: 's' })
  assert.equal(result.ok, false)
  assert.match(result.error, /no tasks/)
})

test('parallel tasks share a wave', () => {
  const result = parseProposePlanArgs({
    tasks: [
      { id: 'a', title: 'a', description: 'd' },
      { id: 'b', title: 'b', description: 'd' },
      { id: 'c', title: 'c', description: 'd', dependsOn: ['a', 'b'] },
    ],
    summary: 's',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.plan.independentGroups, [['a', 'b'], ['c']])
  assert.equal(result.plan.estimatedWorkers, 2)
})

test('parallel conflicts in flat plans are rejected', () => {
  const result = parseProposePlanArgs({
    tasks: [
      { id: 'a', title: 'a', description: 'd', writeFile: ['src/shared.ts'] },
      { id: 'b', title: 'b', description: 'd', writeFile: ['src/shared.ts'] },
    ],
    summary: 's',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /both edit 'src\/shared\.ts'/)
})

test('retries is passed through (0 means 0)', () => {
  const result = parseProposePlanArgs({
    tasks: [{ id: 'a', title: 't', description: 'd', retries: 0 }],
    summary: 's',
  })
  assert.equal(result.ok, true)
  assert.equal(result.plan.tasks[0].retries, 0)
})

test('structured context/edits/verify lower to the flat executor fields (§8)', () => {
  const result = parseProposePlanArgs({
    tasks: [
      {
        id: 'structured',
        title: 't',
        description: 'd',
        context: [{ path: 'src/a.ts', reason: 'edit site' }],
        edits: [
          { path: 'src/a.ts', op: 'modify', anchor: 'const run = 1', change: 'Return a tuple.' },
          { path: 'src/new.ts', op: 'create', change: 'New module.' },
          { path: 'src/old.ts', op: 'delete', change: 'Obsolete.' },
        ],
        verify: [{ command: 'pnpm', args: ['test'], kind: 'proves-change' }],
      },
    ],
    summary: 's',
  })

  assert.equal(result.ok, true)
  const task = result.plan.tasks[0]
  assert.deepEqual(task.readFile, ['src/a.ts'])
  assert.deepEqual(task.writeFile, ['src/a.ts', 'src/new.ts'])
  assert.deepEqual(task.deleteFile, ['src/old.ts'])
  assert.deepEqual(task.instructions, [
    'In src/a.ts, at the text `const run = 1`: Return a tuple.',
    'Create src/new.ts: New module.',
    'Delete src/old.ts: Obsolete.',
  ])
  assert.deepEqual(task.validation, ['pnpm test'])
  // The structured fields survive on the plan so later stages can read them.
  assert.equal(task.edits.length, 3)
  assert.equal(task.verify[0].kind, 'proves-change')
})

test('tasks that omit the structured fields pass through unchanged (§2)', () => {
  const result = parseProposePlanArgs({
    tasks: [
      {
        id: 'legacy',
        title: 't',
        description: 'd',
        instructions: ['Do the thing'],
        readFile: ['src/x.ts'],
        writeFile: ['src/y.ts'],
        validation: ['pnpm build'],
      },
    ],
    summary: 's',
  })

  assert.equal(result.ok, true)
  const task = result.plan.tasks[0]
  assert.deepEqual(task.instructions, ['Do the thing'])
  assert.deepEqual(task.readFile, ['src/x.ts'])
  assert.deepEqual(task.writeFile, ['src/y.ts'])
  assert.deepEqual(task.validation, ['pnpm build'])
  assert.equal(task.context, undefined)
  assert.equal(task.edits, undefined)
  assert.equal(task.verify, undefined)
})
