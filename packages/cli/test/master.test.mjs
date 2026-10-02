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
  orderReadyTasks,
  runRollbackCommands,
  shouldReplan,
} = await import(pathToFileURL(join(root, 'agent', 'master.js')).href)
const { TaskQueue } = await import(pathToFileURL(join(root, 'agent', 'taskqueue.js')).href)
const { TODAYS_PARAMS } = await import(pathToFileURL(join(root, 'bench', 'params.js')).href)

/** The knobs the scheduler reads, with today's values. */
function paramsWith(over = {}) {
  return { ...TODAYS_PARAMS, ...over }
}

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

function harness(specs, { succeed, onRun, workers = 2, interrupted = () => false, params = paramsWith() }) {
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
    params,
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
    params: paramsWith(),
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

test('the Manager skips tasks whose resources are locked and admits independent work', async () => {
  const queue = queueWith([
    plannedTask('a', { writeFile: ['shared.txt'] }),
    plannedTask('b', { writeFile: ['shared.txt'] }),
    plannedTask('c', { writeFile: ['other.txt'] }),
  ])
  const held = new Set()
  const order = []

  await masterLoop({
    queue,
    maxWorkers: 2,
    params: paramsWith(),
    isInterrupted: () => false,
    canAdmitTask: task => task.writeFile.every(path => !held.has(path)),
    runTask: async task => {
      order.push(task.id)
      for (const path of task.writeFile) held.add(path)
      await sleep(task.id === 'a' ? 50 : 10)
      for (const path of task.writeFile) held.delete(path)
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

  assert.ok(order.indexOf('c') < order.indexOf('b'), `b started before independent c: ${order}`)
  assert.deepEqual(new Set(order), new Set(['a', 'b', 'c']))
})

test('the Manager stops scheduling once the plan is aborted', async () => {
  const queue = queueWith([plannedTask('a'), plannedTask('b'), plannedTask('c')])
  const started = []
  const outcome = await masterLoop({
    queue,
    maxWorkers: 1,
    params: paramsWith(),
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
    params: paramsWith(),
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

// --- scheduleOrder ---------------------------------------------------------
//
// One fixed queue, three answers. Nothing is ready but the first four tasks, and
// each has a different claim on being next:
//
//   stub    a leaf, holding up nothing
//   fan     unblocks three dependents, but none of them waits on another
//   chain1  the head of a three-task dependency chain
//   solo    a leaf with a file of its own
//
//   f1 f2 f3  depend on fan
//   chain2 chain3  depend on chain1, then on each other

function orderQueue() {
  return queueWith([
    plannedTask('stub'),
    plannedTask('fan'),
    plannedTask('chain1'),
    plannedTask('solo'),
    plannedTask('f1', { dependsOn: ['fan'] }),
    plannedTask('f2', { dependsOn: ['fan'] }),
    plannedTask('f3', { dependsOn: ['fan'] }),
    plannedTask('chain2', { dependsOn: ['chain1'] }),
    plannedTask('chain3', { dependsOn: ['chain2'] }),
  ])
}

const readyIds = (queue, order, readLocks = 'exclusive') =>
  orderReadyTasks(queue, order, readLocks).map(task => task.id)

test("scheduleOrder 'plan' leaves the ready tasks in plan order", () => {
  const queue = orderQueue()
  assert.deepEqual(readyIds(queue, 'plan'), ['stub', 'fan', 'chain1', 'solo'])
})

test("scheduleOrder 'critical-path' starts the longest chain, not the first task", () => {
  const queue = orderQueue()
  // chain1 -> chain2 -> chain3 is the only chain deeper than two.
  assert.equal(readyIds(queue, 'critical-path')[0], 'chain1')
  // fan -> f* is two deep, so it follows the chain; the leaves keep plan order.
  assert.deepEqual(readyIds(queue, 'critical-path'), ['chain1', 'fan', 'stub', 'solo'])
})

test("scheduleOrder 'most-dependents' unblocks the most work first", () => {
  const queue = orderQueue()
  // fan holds up three tasks, chain1 two — however short each of those chains is.
  assert.deepEqual(readyIds(queue, 'most-dependents'), ['fan', 'chain1', 'stub', 'solo'])
})

test('equal scores keep plan order, so a run is reproducible', () => {
  const queue = queueWith([
    plannedTask('one'),
    plannedTask('two'),
    plannedTask('three'),
    plannedTask('tail-a', { dependsOn: ['one'] }),
    plannedTask('tail-b', { dependsOn: ['two'] }),
    plannedTask('tail-c', { dependsOn: ['three'] }),
  ])
  // Every leaf carries a chain of the same length; nothing may reorder them.
  assert.deepEqual(readyIds(queue, 'critical-path'), ['one', 'two', 'three'])
  assert.deepEqual(readyIds(queue, 'most-dependents'), ['one', 'two', 'three'])
})

test('a same-file task counts as part of the chain', () => {
  const build = () =>
    queueWith([
      plannedTask('other', { writeFile: ['unrelated.txt'] }),
      plannedTask('reader', { writeFile: [], readFile: ['shared.txt'] }),
      plannedTask('writer', { writeFile: ['shared.txt'] }),
    ])

  // `reader` reads shared.txt and `writer` writes it, so the two cannot be in
  // flight together: a chain of two, where the plan gives each its own turn.
  assert.equal(readyIds(build(), 'critical-path', 'exclusive')[0], 'reader')
  // And shared locks do not help there: a reader still waits on a writer.
  assert.equal(readyIds(build(), 'critical-path', 'shared')[0], 'reader')
  // Plan order is untouched, whatever the contention.
  assert.equal(readyIds(build(), 'plan')[0], 'other')
})

test('shared read locks break the chain between two readers', () => {
  const build = () =>
    queueWith([
      plannedTask('r1', { writeFile: [], readFile: ['common.js'] }),
      plannedTask('r2', { writeFile: [], readFile: ['common.js'] }),
      plannedTask('tail', { dependsOn: ['r2'] }),
    ])

  // Exclusive: r1 holds r2 up by lock contention, so r1 carries a three-task
  // chain and goes first.
  assert.equal(readyIds(build(), 'critical-path', 'exclusive')[0], 'r1')
  // Shared: both readers may run together, so neither holds the other up and the
  // only chain left is r2 -> tail.
  assert.equal(readyIds(build(), 'critical-path', 'shared')[0], 'r2')
})

test('a settled chain stops counting', () => {
  const queue = orderQueue()
  queue.completeTask('chain1')
  // chain1 is done, so only the two-deep `fan` and `chain2` chains are left and
  // plan order breaks the tie.
  assert.equal(readyIds(queue, 'critical-path')[0], 'fan')

  queue.completeTask('fan')
  // fan is done too: chain2 still carries chain3, so it leads the leaves.
  assert.equal(readyIds(queue, 'critical-path')[0], 'chain2')

  queue.completeTask('chain2')
  // Nothing is left to wait for; every ready task is a single-task chain.
  assert.deepEqual(readyIds(queue, 'critical-path'), [
    'stub',
    'solo',
    'f1',
    'f2',
    'f3',
    'chain3',
  ])
})

test('the loop starts tasks in the order scheduleOrder picks', async () => {
  for (const [order, first, second] of [
    ['plan', 'stub', 'fan'],
    ['critical-path', 'chain1', 'fan'],
    ['most-dependents', 'fan', 'chain1'],
  ]) {
    const queue = orderQueue()
    const started = []

    await masterLoop({
      queue,
      maxWorkers: 1,
      params: paramsWith({ scheduleOrder: order }),
      isInterrupted: () => false,
      runTask: async task => {
        started.push(task.id)
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

    assert.deepEqual(
      started.slice(0, 2),
      [first, second],
      `${order} should start ${first}, then ${second}: ${started.join(', ')}`,
    )
    assert.equal(queue.getStatus().done, 9, `${order} must still drain the whole plan`)
  }
})

test("scheduleOrder does not reorder work that cannot start yet", async () => {
  // Only one task is ready whatever the order says; the loop must not reach
  // past it for the ones still waiting on a dependency.
  const queue = queueWith([
    plannedTask('gate'),
    plannedTask('later-a', { dependsOn: ['gate'] }),
    plannedTask('later-b', { dependsOn: ['gate'] }),
  ])
  const started = []

  await masterLoop({
    queue,
    maxWorkers: 1,
    params: paramsWith({ scheduleOrder: 'critical-path' }),
    isInterrupted: () => false,
    runTask: async task => {
      started.push(task.id)
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

  assert.equal(started[0], 'gate')
  assert.equal(started.length, 3)
})
