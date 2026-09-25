import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const {
  blockedDependents,
  decideFailure,
  masterDecide,
  masterLoop,
  runRollbackCommands,
  shouldReplan,
} = await import(pathToFileURL(join(root, 'agent', 'master.js')).href)
const { TaskQueue } = await import(pathToFileURL(join(root, 'agent', 'taskqueue.js')).href)

function plannedTask(id, over = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    instructions: [],
    readFile: [],
    writeFile: [`${id}.txt`],
    deleteFile: [],
    createDir: [],
    validation: [],
    dependsOn: [],
    type: 'create',
    retries: 0,
    timeoutSeconds: 60,
    rollback: [],
    skipIf: [],
    ...over,
  }
}

function queueWith(specs) {
  const queue = new TaskQueue('session-1', 60)
  for (const spec of specs) queue.addTask(spec)
  return queue
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// --- the mechanical decision ---------------------------------------------

test('a fresh failure is retried', () => {
  const queue = queueWith([plannedTask('a')])
  const decision = decideFailure({
    task: queue.getTask('a'),
    attempts: 0,
    maxRetries: 2,
    noChanges: false,
    interrupted: false,
  })
  assert.equal(decision.action, 'retry')
})

test('retries are bounded by the task cap', () => {
  const queue = queueWith([plannedTask('a', { retries: 1 })])
  const task = queue.getTask('a')

  // retries: 1 means one attempt plus one retry, so after two attempts there
  // is nothing left to give.
  const last = decideFailure({
    task, attempts: 1, maxRetries: 1, noChanges: false, interrupted: false,
  })
  assert.equal(last.action, 'retry', 'the second attempt is the allowed retry')

  const exhausted = decideFailure({
    task, attempts: 2, maxRetries: 1, noChanges: false, interrupted: false,
  })
  assert.equal(exhausted.action, 'skip')
  assert.match(exhausted.reason, /retries exhausted/)
})

test('a task that changed nothing is not retried', () => {
  // Retrying an identical attempt against an identical tree cannot do better;
  // it only delays the report.
  const queue = queueWith([plannedTask('a')])
  const decision = decideFailure({
    task: queue.getTask('a'),
    attempts: 0,
    maxRetries: 5,
    noChanges: true,
    interrupted: false,
  })
  assert.equal(decision.action, 'skip')
  assert.match(decision.reason, /no changes/)
})

test('an interrupt is never a failure', () => {
  const queue = queueWith([plannedTask('a')])
  const decision = decideFailure({
    task: queue.getTask('a'),
    attempts: 0,
    maxRetries: 5,
    noChanges: false,
    interrupted: true,
  })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'interrupted')
})

test('enough failures abort the plan instead of thrashing', () => {
  const queue = queueWith([plannedTask('a')])
  const decision = decideFailure({
    task: queue.getTask('a'),
    attempts: 0,
    maxRetries: 5,
    noChanges: false,
    interrupted: false,
    abortAfterFailures: 2,
    failureCount: 2,
  })
  assert.equal(decision.action, 'abort')
})

test('the decision is deterministic', () => {
  const queue = queueWith([plannedTask('a')])
  const input = {
    task: queue.getTask('a'),
    attempts: 0,
    maxRetries: 2,
    noChanges: false,
    interrupted: false,
  }
  const first = decideFailure(input)
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(decideFailure(input), first, 'the same inputs must give the same action')
  }
})

// --- rollback -------------------------------------------------------------

test("a task's rollback commands run in order", async () => {
  const seen = []
  const handle = {
    async callTool(name, args) {
      assert.equal(name, 'run_command')
      seen.push(args.command)
      return JSON.stringify({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    },
  }
  const result = await runRollbackCommands(['git checkout a.ts', 'rm -f b.ts'], handle)
  assert.deepEqual(seen, ['git checkout a.ts', 'rm -f b.ts'])
  assert.deepEqual(result.ran, ['git checkout a.ts', 'rm -f b.ts'])
  assert.deepEqual(result.failed, [])
})

test('a failing rollback command is reported, not swallowed', async () => {
  const handle = {
    async callTool(_name, args) {
      return JSON.stringify({
        exitCode: args.command.includes('bad') ? 128 : 0,
        signal: null,
        stdout: '',
        stderr: 'no such path',
      })
    },
  }
  const result = await runRollbackCommands(['git checkout ok.ts', 'git checkout bad.ts'], handle)
  assert.deepEqual(result.ran, ['git checkout ok.ts'])
  assert.deepEqual(result.failed, ['git checkout bad.ts'])
})

test('a rollback command that throws is captured, not propagated', async () => {
  const handle = {
    async callTool() {
      throw new Error('sandbox gone')
    },
  }
  const result = await runRollbackCommands(['git checkout a.ts'], handle)
  assert.deepEqual(result.failed, ['git checkout a.ts'])
  assert.match(result.output, /sandbox gone/)
})

test('empty rollback commands are a no-op', async () => {
  let called = false
  const handle = {
    async callTool() {
      called = true
      return '{}'
    },
  }
  const result = await runRollbackCommands(['', '   '], handle)
  assert.equal(called, false)
  assert.deepEqual(result.ran, [])
})

// --- dependency arithmetic -----------------------------------------------

test('dependents of a failure are found transitively', () => {
  const queue = queueWith([
    plannedTask('a'),
    plannedTask('b', { dependsOn: ['a'] }),
    plannedTask('c', { dependsOn: ['b'] }),
    plannedTask('unrelated'),
  ])
  const blocked = blockedDependents(queue, 'a')
  assert.deepEqual(blocked.sort(), ['b', 'c'])
  assert.equal(shouldReplan(queue, 'a'), true)
})

test('a leaf failure blocks nobody', () => {
  const queue = queueWith([plannedTask('a'), plannedTask('b', { dependsOn: ['a'] })])
  assert.deepEqual(blockedDependents(queue, 'b'), [])
  assert.equal(shouldReplan(queue, 'b'), false)
})

// --- the loop -------------------------------------------------------------

function harness(specs, { succeed, onRun, workers = 2, interrupted = () => false }) {
  const queue = queueWith(specs)
  const calls = []
  const events = []
  const parked = []
  const failed = []
  const rollbacks = []
  const noOp = new Set()

  const deps = {
    queue,
    maxWorkers: workers,
    isInterrupted: interrupted,
    runTask: async task => {
      calls.push(task.id)
      onRun?.(task)
      const ok = succeed(task, calls.filter(c => c === task.id).length)
      if (ok) {
        queue.completeTask(task.id, true)
      } else {
        queue.startTask(task.id)
        queue.startTask(task.id)
      }
      return ok
    },
    taskWasNoOp: id => noOp.has(id),
    rollbackTask: async task => {
      rollbacks.push(task.id)
    },
    // Mirrors the real callback in service.ts, which reports the transition.
    failTask: async task => {
      failed.push(task.id)
      queue.failTask(task.id)
      events.push({ type: 'failed', title: task.title })
    },
    parkTask: async task => {
      parked.push(task.id)
      queue.returnToPending(task.id)
    },
    rebaselineTask: async () => {},
    onTaskEvent: e => events.push(e),
  }
  return { queue, calls, events, parked, failed, rollbacks, deps }
}

test('the Manager retries a failure until the cap, then fails it', async () => {
  const h = harness([plannedTask('a', { retries: 1 })], {
    succeed: () => false,
  })
  const outcome = await masterLoop(h.deps)

  // Two attempts: the original and one retry.
  assert.deepEqual(h.calls, ['a', 'a'])
  assert.deepEqual(outcome.retried, ['a'])
  assert.deepEqual(h.failed, ['a'])
  assert.deepEqual(h.rollbacks, ['a'])
  assert.equal(h.events.filter(e => e.type === 'retry').length, 1)
  assert.equal(h.events.filter(e => e.type === 'failed').length, 1)
})

test('the Manager does not retry a task that changed nothing', async () => {
  const h = harness([plannedTask('a', { retries: 3 })], {
    succeed: () => false,
  })
  h.deps.taskWasNoOp = () => true
  const outcome = await masterLoop(h.deps)

  assert.deepEqual(h.calls, ['a'], 'exactly one attempt')
  assert.deepEqual(outcome.retried, [])
  assert.deepEqual(h.failed, ['a'])
})

test('the Manager rolls back before it retries', async () => {
  const order = []
  const h = harness([plannedTask('a', { retries: 1 })], {
    succeed: () => false,
    onRun: () => order.push('run'),
  })
  h.deps.rollbackTask = async task => {
    order.push(`rollback:${task.id}`)
  }
  h.deps.rebaselineTask = async task => {
    order.push(`rebaseline:${task.id}`)
  }
  await masterLoop(h.deps)
  assert.deepEqual(order, ['run', 'rollback:a', 'rebaseline:a', 'run'])
})

test('the Manager runs independent tasks concurrently and tops the pool back up', async () => {
  const queue = queueWith([
    plannedTask('a'),
    plannedTask('b'),
    plannedTask('c'),
    plannedTask('d'),
  ])
  let active = 0
  let maxActive = 0
  const started = []

  const outcome = await masterLoop({
    queue,
    maxWorkers: 4,
    isInterrupted: () => false,
    runTask: async task => {
      started.push(task.id)
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(60)
      active--
      queue.completeTask(task.id, true)
      return true
    },
    taskWasNoOp: () => false,
    rollbackTask: async () => {},
    failTask: () => {},
    parkTask: () => {},
    rebaselineTask: async () => {},
    onTaskEvent: () => {},
  })

  assert.equal(maxActive, 4, `expected 4 in flight, peak was ${maxActive}`)
  assert.equal(started.length, 4)
  assert.equal(outcome.aborted, false)
})

test('the Manager stops scheduling once the plan is aborted', async () => {
  const queue = queueWith([plannedTask('a'), plannedTask('b'), plannedTask('c')])
  const started = []
  const outcome = await masterLoop({
    queue,
    maxWorkers: 1,
    isInterrupted: () => false,
    runTask: async task => {
      started.push(task.id)
      await sleep(5)
      if (task.id === 'a') {
        queue.startTask(task.id)
        return false
      }
      queue.completeTask(task.id, true)
      return true
    },
    taskWasNoOp: () => false,
    rollbackTask: async () => {},
    failTask: () => {},
    parkTask: () => {},
    rebaselineTask: async () => {},
    onTaskEvent: () => {},
    abortAfterFailures: 1,
  })

  assert.equal(outcome.aborted, true)
  // The invariant that matters: once aborted, no *other* task is started.
  assert.ok(started.every(id => id === 'a'), `kept scheduling after an abort: ${started}`)
})

test('an interrupted run parks in-flight work instead of failing it', async () => {
  const queue = queueWith([plannedTask('a')])
  let interrupted = false
  const parked = []
  const failed = []

  await masterLoop({
    queue,
    maxWorkers: 1,
    isInterrupted: () => interrupted,
    runTask: async task => {
      queue.startTask(task.id)
      interrupted = true
      return false
    },
    taskWasNoOp: () => false,
    rollbackTask: async () => {},
    failTask: t => {
      failed.push(t.id)
    },
    parkTask: t => {
      parked.push(t.id)
      queue.returnToPending(t.id)
    },
    rebaselineTask: async () => {},
    onTaskEvent: () => {},
  })

  assert.deepEqual(parked, ['a'])
  assert.deepEqual(failed, [], 'an interrupt is not a failure')
  assert.equal(queue.getTask('a').status, 'pending')
})

test('the LLM decision loop is opt-in and maps tools to actions', async () => {
  const queue = queueWith([plannedTask('a', { retries: 2 })])
  queue.startTask('a')
  const task = queue.getTask('a')
  const context = { reason: 'test', noChanges: false, attempts: 0, maxRetries: 2 }

  for (const [tool, expected] of [
    ['retry_task', 'retry'],
    ['abort_plan', 'abort'],
    ['get_task_status', 'skip'],
  ]) {
    const action = await masterDecide(
      { queue, ask: async () => [{ name: tool, args: { taskId: 'a' } }] },
      task,
      context,
    )
    assert.equal(action, expected, `${tool} should map to ${expected}`)
  }

  // A model that says nothing actionable resolves to 'skip', never to a
  // silent retry storm.
  assert.equal(
    await masterDecide({ queue, ask: async () => [] }, task, context),
    'skip',
  )
})
