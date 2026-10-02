import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileLockManager } from '@codekalakaars/vajra-sandbox'

const root = join(import.meta.dirname, '..', 'dist')
const { leasePaths, taskLeases, tasksConflict } = await import(
  pathToFileURL(join(root, 'agent', 'leases.js')).href
)
const { masterLoop } = await import(pathToFileURL(join(root, 'agent', 'master.js')).href)
const { TaskQueue } = await import(pathToFileURL(join(root, 'agent', 'taskqueue.js')).href)
const { TODAYS_PARAMS } = await import(pathToFileURL(join(root, 'bench', 'params.js')).href)

const READS_ONLY = { readFile: ['src/a.js'], writeFile: [], deleteFile: [], createDir: [] }
const WRITES_A = { readFile: [], writeFile: ['src/a.js'], deleteFile: [], createDir: [] }

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

function queueWith(specs) {
  const queue = new TaskQueue('session-1', 60)
  for (const spec of specs) queue.addTask(spec)
  return queue
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --- the leases themselves -------------------------------------------------

test('exclusive leases every path for writing, reads included', () => {
  const task = {
    readFile: ['src/a.js'],
    writeFile: ['src/b.js'],
    deleteFile: ['src/c.js'],
    createDir: ['src/d'],
  }
  const expected = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d'].map(path => ({ path, mode: 'write' }))
  assert.deepEqual(taskLeases(task, 'exclusive'), expected)
})

test("shared leases read files for reading and the rest for writing", () => {
  const task = {
    readFile: ['src/a.js', 'src/shared.js'],
    writeFile: ['src/b.js'],
    deleteFile: ['src/c.js'],
    createDir: ['src/d'],
  }
  assert.deepEqual(taskLeases(task, 'shared'), [
    { path: 'src/a.js', mode: 'read' },
    { path: 'src/shared.js', mode: 'read' },
    { path: 'src/b.js', mode: 'write' },
    { path: 'src/c.js', mode: 'write' },
    { path: 'src/d', mode: 'write' },
  ])
})

test('a path a task both reads and writes is leased once, for writing', () => {
  const task = {
    readFile: ['src/a.js'],
    writeFile: ['src/a.js', 'src/b.js'],
    deleteFile: ['src/a.js'],
    createDir: [],
  }
  assert.deepEqual(taskLeases(task, 'shared'), [
    { path: 'src/a.js', mode: 'write' },
    { path: 'src/b.js', mode: 'write' },
  ])
})

test('both modes name the same paths, in the same order', () => {
  const task = {
    readFile: ['r1.js', 'r2.js'],
    writeFile: ['w1.js'],
    deleteFile: ['d1.js'],
    createDir: ['dir'],
  }
  assert.deepEqual(
    leasePaths(task),
    taskLeases(task, 'exclusive').map(lease => lease.path),
  )
  assert.deepEqual(
    leasePaths(task),
    taskLeases(task, 'shared').map(lease => lease.path),
  )
})

// --- what blocks what ------------------------------------------------------

test('exclusive: two readers of one file conflict, as any two writers do', () => {
  const reader = { id: 'r', ...READS_ONLY }
  const otherReader = { id: 'o', ...READS_ONLY }
  assert.equal(tasksConflict(reader, otherReader, 'exclusive'), true)
  assert.equal(tasksConflict(reader, { id: 'w', ...WRITES_A }, 'exclusive'), true)
})

test("shared: readers of one file are free together, a writer is not", () => {
  const reader = { id: 'r', ...READS_ONLY }
  const otherReader = { id: 'o', ...READS_ONLY }
  const writer = { id: 'w', ...WRITES_A }
  assert.equal(tasksConflict(reader, otherReader, 'shared'), false)
  assert.equal(tasksConflict(reader, writer, 'shared'), true)
  assert.equal(tasksConflict(writer, { id: 'w2', ...WRITES_A }, 'shared'), true)
  assert.equal(tasksConflict(writer, writer, 'shared'), false, 'a task never conflicts with itself')
})

test('shared: unrelated files never conflict', () => {
  const a = { id: 'a', readFile: ['a.js'], writeFile: [], deleteFile: [], createDir: [] }
  const b = { id: 'b', readFile: ['b.js'], writeFile: ['c.js'], deleteFile: [], createDir: [] }
  assert.equal(tasksConflict(a, b, 'shared'), false)
  assert.equal(tasksConflict(a, b, 'exclusive'), false)
})

// --- admission under the two modes -----------------------------------------
//
// Mirrors what session/service.ts does with the leases: `canAdmitTask` asks the
// lock manager whether the task's read and write paths are free, and the attempt
// takes them for the duration of the task.

function splitLeases(task, readLocks) {
  const leases = taskLeases(task, readLocks)
  return {
    read: leases.filter(l => l.mode === 'read').map(l => l.path),
    write: leases.filter(l => l.mode === 'write').map(l => l.path),
  }
}

/**
 * Run one plan and report what overlapped: how many readers were ever in flight
 * together, and every pair that should not have been.
 */
async function runAdmission(specs, readLocks, { workers = 4 } = {}) {
  const queue = queueWith(specs)
  const locks = new FileLockManager()
  const active = { read: new Set(), write: new Set() }
  const clashes = []
  let readersTogether = false

  await masterLoop({
    queue,
    maxWorkers: workers,
    isInterrupted: () => false,
    params: { ...TODAYS_PARAMS, readLocks },
    canAdmitTask: task => {
      const { read, write } = splitLeases(task, readLocks)
      return locks.canAcquire(read, 'read', task.id) && locks.canAcquire(write, 'write', task.id)
    },
    runTask: async task => {
      const { read, write } = splitLeases(task, readLocks)
      locks.tryAcquire(read, task.id, 'read')
      locks.tryAcquire(write, task.id, 'write')
      if (write.length > 0) {
        if (active.write.size > 0) clashes.push(`two writers in flight: ${[...active.write, task.id]}`)
        if (active.read.size > 0) clashes.push(`writer beside a reader: ${[...active.read, task.id]}`)
        active.write.add(task.id)
      } else {
        if (active.read.size > 0) readersTogether = true
        active.read.add(task.id)
      }
      try {
        await sleep(40)
        queue.completeTask(task.id, true)
        return true
      } finally {
        locks.release(task.id)
        active.read.delete(task.id)
        active.write.delete(task.id)
      }
    },
    taskWasNoOp: () => false,
    rollbackTask: async () => {},
    failTask: () => {},
    parkTask: () => {},
    rebaselineTask: async () => {},
    onTaskEvent: () => {},
  })

  return { readersTogether, clashes, queue }
}

test('shared: two read-only tasks on one file run together, and writers still serialise', async () => {
  const shared = 'shared.js'
  const { readersTogether, clashes, queue } = await runAdmission(
    [
      plannedTask('r1', { writeFile: [], readFile: [shared] }),
      plannedTask('r2', { writeFile: [], readFile: [shared] }),
      plannedTask('w1', { writeFile: [shared] }),
      plannedTask('w2', { writeFile: [shared] }),
    ],
    'shared',
  )

  assert.equal(readersTogether, true, 'shared locks must let both readers be in flight at once')
  assert.deepEqual(clashes, [], 'writers must never overlap a reader or each other')
  assert.equal(queue.getStatus().done, 4)
})

test('exclusive: the same plan runs the readers one at a time', async () => {
  const shared = 'shared.js'
  const { readersTogether, clashes, queue } = await runAdmission(
    [
      plannedTask('r1', { writeFile: [], readFile: [shared] }),
      plannedTask('r2', { writeFile: [], readFile: [shared] }),
      plannedTask('w1', { writeFile: [shared] }),
      plannedTask('w2', { writeFile: [shared] }),
    ],
    'exclusive',
  )

  assert.equal(readersTogether, false, "exclusive locks are today's behaviour: readers serialise")
  assert.deepEqual(clashes, [])
  assert.equal(queue.getStatus().done, 4)
})
// --- path spelling --------------------------------------------------------

test('two spellings of one file are one lease', () => {
  const dotted = { id: 'a', readFile: [], writeFile: ['./src/a.js'], deleteFile: [], createDir: [] }
  const plain = { id: 'b', readFile: [], writeFile: ['src/a.js'], deleteFile: [], createDir: [] }
  assert.deepEqual(taskLeases(dotted, 'exclusive'), [{ path: 'src/a.js', mode: 'write' }])
  assert.equal(tasksConflict(dotted, plain, 'exclusive'), true)
  assert.equal(tasksConflict(dotted, plain, 'shared'), true)
})

test('with a project directory, an absolute path inside it is the same lease as a relative one', () => {
  const task = { readFile: ['/work/proj/src/a.js'], writeFile: ['src//b.js'], deleteFile: [], createDir: ['src/out/'] }
  assert.deepEqual(taskLeases(task, 'exclusive', '/work/proj').map(lease => lease.path), [
    'src/a.js',
    'src/b.js',
    'src/out',
  ])
})

test('the lock manager refuses a second writer that spells the path differently', () => {
  const locks = new FileLockManager()
  const first = taskLeases({ readFile: [], writeFile: ['./src/a.js'], deleteFile: [], createDir: [] }, 'exclusive', '/p')
  const second = taskLeases({ readFile: [], writeFile: ['src/a.js'], deleteFile: [], createDir: [] }, 'exclusive', '/p')
  assert.equal(locks.tryAcquire(first.map(l => l.path), "first", "write"), true)
  assert.equal(locks.canAcquire(second.map(l => l.path), 'write', 'second'), false)
})
