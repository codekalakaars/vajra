import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const load = path => import(pathToFileURL(join(root, path)).href)
const { Governor, systemSampler } = await load('manager/governor.js')
const { PauseGate } = await load('manager/pause.js')
const { masterLoop } = await load('manager/master.js')
const { TaskQueue } = await load('manager/taskqueue.js')
const { TODAYS_PARAMS } = await load('bench/params.js')

/** A machine the test owns: change `reading` and the next sample sees it. */
function fakeMachine(reading) {
  const machine = { reading: { cpu: 0, availableMemMb: 64_000, ...reading } }
  machine.sampler = () => ({ ...machine.reading })
  return machine
}

const params = over => ({ ...TODAYS_PARAMS, resourceSampleMs: 20, ...over })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function plannedTask(id, over = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    instructions: [],
    readFile: [],
    writeFile: [`${id}.js`],
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

/**
 * A scheduler run whose tasks finish only when the test says so, with the
 * pause and resume calls it makes recorded.
 */
function controlledRun(specs, governor, { maxWorkers = Number.POSITIVE_INFINITY, runParams = params() } = {}) {
  const queue = new TaskQueue('s', 60)
  for (const spec of specs) queue.addTask(spec)
  const finish = new Map()
  const live = new Set()
  const pauses = []
  const resumes = []
  let peak = 0
  const deps = {
    queue,
    maxWorkers,
    params: runParams,
    isInterrupted: () => false,
    resources: {
      governor,
      pauseTask: task => {
        pauses.push(task.id)
        return true
      },
      resumeTask: task => {
        resumes.push(task.id)
      },
    },
    runTask: task => {
      queue.startTask(task.id)
      live.add(task.id)
      peak = Math.max(peak, live.size)
      return new Promise(resolve => {
        finish.set(task.id, () => {
          live.delete(task.id)
          queue.completeTask(task.id, true)
          resolve(true)
        })
      })
    },
    taskWasNoOp: () => false,
    rollbackTask: async () => {},
    failTask: async () => {},
    parkTask: async () => {},
    rebaselineTask: async () => {},
    onTaskEvent: () => {},
  }
  return {
    live,
    pauses,
    resumes,
    peak: () => peak,
    finish: id => finish.get(id)?.(),
    finishAll: () => [...finish.values()].forEach(done => done()),
    done: masterLoop(deps),
  }
}

// --- the governor -------------------------------------------------------

test('a Worker is admitted while CPU is below the resume line and RAM has room', () => {
  const machine = fakeMachine({ cpu: 0.5, availableMemMb: 2000 })
  const governor = new Governor(params({ minFreeMemMb: 1000, workerMemMb: 400 }), machine.sampler)
  assert.equal(governor.canAdmit(), true)
  governor.noteAdmitted()
  assert.equal(governor.canAdmit(), true, '2000 - 2 x 400 still leaves 1000')
  governor.noteAdmitted()
  assert.equal(governor.canAdmit(), false, 'a third would leave 800, under the floor')
  governor.sample()
  assert.equal(governor.canAdmit(), true, 'a fresh reading clears what was set aside')
})

test('between the two CPU lines nothing is paused, resumed or admitted', () => {
  const machine = fakeMachine({ cpu: 0.8 })
  const governor = new Governor(params({ cpuPauseAt: 0.9, cpuResumeAt: 0.75 }), machine.sampler)
  assert.equal(governor.choking(), false)
  assert.equal(governor.relieved(), false)
  assert.equal(governor.canAdmit(), false)
  machine.reading.cpu = 0.95
  governor.sample()
  assert.equal(governor.choking(), true)
  machine.reading.cpu = 0.5
  governor.sample()
  assert.equal(governor.relieved(), true)
  assert.equal(governor.canAdmit(), true)
})

test('the system sampler reads a CPU share and available memory', () => {
  const reading = systemSampler()()
  assert.ok(reading.cpu >= 0 && reading.cpu <= 1, `cpu ${reading.cpu}`)
  assert.ok(reading.availableMemMb > 0, `memory ${reading.availableMemMb}`)
})

// --- the pause gate -----------------------------------------------------

test('a shut gate holds its waiters until resumed, and counts the time', async () => {
  let now = 1000
  const gate = new PauseGate(() => now)
  await gate.wait() // open: returns at once
  gate.pause()
  let passed = false
  const waiting = gate.wait().then(() => {
    passed = true
  })
  await sleep(10)
  assert.equal(passed, false)
  now = 1300
  assert.equal(gate.pausedMs(), 300)
  gate.resume()
  await waiting
  assert.equal(passed, true)
  assert.equal(gate.pausedMs(), 300)
})

// --- the scheduler with no Worker count ------------------------------------

test('with room on the machine, every ready task runs at once: there is no Worker count', async () => {
  const machine = fakeMachine({ cpu: 0.1 })
  const governor = new Governor(params(), machine.sampler)
  const specs = Array.from({ length: 9 }, (_, i) => plannedTask(`t${i}`))
  const run = controlledRun(specs, governor)
  await sleep(30)
  assert.equal(run.live.size, 9)
  run.finishAll()
  await run.done
  assert.equal(run.peak(), 9)
})

test('RAM decides how many start, and a new reading lets more in', async () => {
  const machine = fakeMachine({ cpu: 0.1, availableMemMb: 1000 + 3 * 100 })
  const governor = new Governor(params({ minFreeMemMb: 1000, workerMemMb: 100, resourceSampleMs: 10_000 }), machine.sampler)
  const specs = Array.from({ length: 6 }, (_, i) => plannedTask(`t${i}`))
  const run = controlledRun(specs, governor)
  await sleep(20)
  assert.equal(run.live.size, 3, 'room for three Workers above the floor')
  machine.reading.availableMemMb = 1000 + 2 * 100
  governor.sample()
  await sleep(20)
  assert.equal(run.live.size, 5)
  machine.reading.availableMemMb = 64_000
  governor.sample()
  await sleep(20)
  run.finishAll()
  await sleep(20)
  run.finishAll()
  await run.done
})

test('a busy machine still starts one task, so the run moves', async () => {
  const machine = fakeMachine({ cpu: 1, availableMemMb: 10 })
  const governor = new Governor(params({ resourceSampleMs: 10_000 }), machine.sampler)
  const run = controlledRun([plannedTask('a'), plannedTask('b')], governor)
  await sleep(20)
  assert.deepEqual([...run.live], ['a'])
  run.finish('a')
  await sleep(20)
  assert.deepEqual([...run.live], ['b'])
  run.finish('b')
  await run.done
})

test('a choking CPU pauses the lowest-priority Worker first, never the last one, and resumes the highest first', async () => {
  // `root` holds up `after`, so it is the highest priority; `leaf1` and `leaf2`
  // hold up nothing, and `leaf2` comes later in the plan, so it ranks lowest.
  const specs = [
    plannedTask('root'),
    plannedTask('leaf1'),
    plannedTask('leaf2'),
    plannedTask('after', { dependsOn: ['root'] }),
  ]
  const machine = fakeMachine({ cpu: 0.1 })
  const governor = new Governor(params(), machine.sampler)
  const run = controlledRun(specs, governor)
  await sleep(10)
  assert.deepEqual([...run.live].sort(), ['leaf1', 'leaf2', 'root'])

  machine.reading.cpu = 0.99
  await sleep(150)
  assert.deepEqual(run.pauses, ['leaf2', 'leaf1'], 'one per reading, lowest first, and root keeps running')

  machine.reading.cpu = 0.1
  await sleep(150)
  assert.deepEqual(run.resumes, ['leaf1', 'leaf2'], 'highest priority resumes first')

  run.finish('root')
  run.finish('leaf1')
  run.finish('leaf2')
  await sleep(30)
  run.finish('after')
  await run.done
})

test('nothing new starts while a Worker is paused', async () => {
  const machine = fakeMachine({ cpu: 0.1 })
  const governor = new Governor(params(), machine.sampler)
  const specs = [plannedTask('a'), plannedTask('b'), plannedTask('c', { dependsOn: ['a'] })]
  const run = controlledRun(specs, governor)
  await sleep(10)
  machine.reading.cpu = 0.99
  await sleep(60)
  assert.deepEqual(run.pauses, ['b'])
  // `c` becomes ready, but CPU is between the lines: it must not start.
  machine.reading.cpu = 0.8
  run.finish('a')
  await sleep(60)
  assert.equal(run.live.has('c'), false)
  machine.reading.cpu = 0.1
  await sleep(60)
  assert.deepEqual(run.resumes, ['b'])
  assert.equal(run.live.has('c'), true)
  run.finishAll()
  await run.done
})

test('a paused Worker is resumed when the run ends, so it can finish', async () => {
  const machine = fakeMachine({ cpu: 0.1 })
  const governor = new Governor(params(), machine.sampler)
  let interrupted = false
  const queue = new TaskQueue('s', 60)
  for (const spec of [plannedTask('a'), plannedTask('b')]) queue.addTask(spec)
  const resumes = []
  const settle = []
  const done = masterLoop({
    queue,
    maxWorkers: Number.POSITIVE_INFINITY,
    params: params(),
    isInterrupted: () => interrupted,
    resources: { governor, pauseTask: () => true, resumeTask: task => resumes.push(task.id) },
    runTask: task => new Promise(resolve => settle.push(() => resolve(false))),
    taskWasNoOp: () => false,
    rollbackTask: async () => {},
    failTask: async () => {},
    parkTask: async () => {},
    rebaselineTask: async () => {},
    onTaskEvent: () => {},
  })
  await sleep(10)
  machine.reading.cpu = 0.99
  await sleep(60)
  interrupted = true
  await sleep(60)
  assert.deepEqual(resumes, ['b'])
  settle.forEach(fn => fn())
  await done
})
