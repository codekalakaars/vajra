// Tests for the plan post-processing in agent/manager.ts.
//
// The dependency graph handed to the master must be acyclic: TaskQueue only
// releases a task once every dependency is done, so a cycle strands every
// task in it as permanently un-ready and the run ends reporting neither
// success nor failure.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseProposePlanArgs } from '../dist/agent/manager.js'

function task(overrides) {
  return {
    title: 'a task',
    description: 'why',
    instructions: ['do it'],
    readFile: [],
    writeFile: [],
    deleteFile: [],
    createDir: [],
    validation: [],
    dependsOn: [],
    type: 'modify',
    ...overrides,
  }
}

/** Walk the graph; throws if any cycle survives. */
function assertAcyclic(plan) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const visited = new Set()
  const onStack = new Set()

  function visit(id, path) {
    if (onStack.has(id)) {
      assert.fail(`cycle in task graph: ${[...path, id].join(' -> ')}`)
    }
    if (visited.has(id)) return
    visited.add(id)
    onStack.add(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      visit(dep, [...path, id])
    }
    onStack.delete(id)
  }

  for (const t of plan.tasks) visit(t.id, [])
}

test('two tasks writing the same file do not deadlock each other', () => {
  const plan = parseProposePlanArgs({
    summary: 'shared output',
    tasks: [
      task({ title: 'first', writeFile: ['src/app.ts'] }),
      task({ title: 'second', writeFile: ['src/app.ts'] }),
    ],
  })

  assertAcyclic(plan)

  // They cannot run in parallel, so one must wait on the other.
  const [first, second] = plan.tasks
  const serialized =
    second.dependsOn.includes(first.id) || first.dependsOn.includes(second.id)
  assert.ok(serialized, 'tasks writing the same file should be serialized')
})

test('a reader depends on the task that writes its input', () => {
  const plan = parseProposePlanArgs({
    summary: 'producer/consumer',
    tasks: [
      task({ title: 'writer', writeFile: ['src/generated.ts'] }),
      task({ title: 'reader', readFile: ['src/generated.ts'] }),
    ],
  })

  assertAcyclic(plan)
  const writer = plan.tasks.find((t) => t.title === 'writer')
  const reader = plan.tasks.find((t) => t.title === 'reader')
  assert.ok(reader.dependsOn.includes(writer.id))
})

test('an explicit cycle from the model is broken', () => {
  const plan = parseProposePlanArgs({
    summary: 'model proposed a cycle',
    tasks: [
      task({ title: 'a', dependsOn: ['task-3'] }),
      task({ title: 'b', dependsOn: ['task-1'] }),
      task({ title: 'c', dependsOn: ['task-2'] }),
    ],
  })

  assertAcyclic(plan)
})

test('breaking a cycle keeps the dependencies that are not part of it', () => {
  const plan = parseProposePlanArgs({
    summary: 'mutual writers plus a real prerequisite',
    tasks: [
      task({ title: 'setup', writeFile: ['src/config.ts'] }),
      task({ title: 'x', readFile: ['src/config.ts'], writeFile: ['src/app.ts'] }),
      task({ title: 'y', readFile: ['src/config.ts'], writeFile: ['src/app.ts'] }),
    ],
  })

  assertAcyclic(plan)
  const setup = plan.tasks.find((t) => t.title === 'setup')
  for (const title of ['x', 'y']) {
    const t = plan.tasks.find((x) => x.title === title)
    assert.ok(t.dependsOn.includes(setup.id), `${title} should still depend on setup`)
  }
})

test('dependencies on task ids that do not exist are dropped', () => {
  const plan = parseProposePlanArgs({
    summary: 'hallucinated dependency',
    tasks: [task({ title: 'only', dependsOn: ['task-99'] })],
  })

  assert.deepEqual(plan.tasks[0].dependsOn, [])
})
