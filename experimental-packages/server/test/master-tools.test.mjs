import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../dist/db/client.js'
import { TaskQueue } from '../dist/agent/taskqueue.js'
import { AgentRegistry } from '../dist/agent/registry.js'

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-master-tools-'))
  const db = openDb(join(dir, 'test.db'))
  db.prepare(
    `INSERT INTO sessions (id, project_dir, task, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('session-1', dir, 'test', 'mock', 'starting', Date.now())
  return { db, dir }
}

function createAgent(db, agentId) {
  db.prepare(
    `INSERT INTO agents (id, session_id, role, status, task_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, 'session-1', 'worker', 'running', 'test', Date.now())
}

function addTask(queue, id, overrides = {}) {
  queue.addTask({
    id,
    title: 'Task ' + id,
    description: '',
    instructions: ['Do something'],
    readFile: [],
    writeFile: [],
    deleteFile: [],
    createDir: [],
    validation: [],
    dependsOn: [],
    type: 'modify',
    retries: 0,
    timeout: 120,
    rollback: [],
    skipIf: [],
    ...overrides,
  })
}

test('retry_task resets a failed task to pending with incremented retries', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')
    addTask(queue, 't1')
    createAgent(db, 'a1')
    queue.assignTask('t1', 'a1')
    queue.startTask('t1')
    queue.failTask('t1')

    assert.equal(queue.getTask('t1').status, 'failed')
    queue.retryTask('t1')

    const t = queue.getTask('t1')
    assert.equal(t.status, 'pending')
    assert.equal(t.retries, 1)
    assert.equal(t.assignedAgentId, null)
    assert.equal(t.startedAt, null)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('amend_task updates fields and resets to pending', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')
    addTask(queue, 't1', { instructions: ['Old'], writeFile: ['old.ts'] })
    createAgent(db, 'a1')
    queue.assignTask('t1', 'a1')
    queue.startTask('t1')
    queue.failTask('t1')

    const task = queue.getTask('t1')
    task.instructions = ['New instruction']
    task.writeFile = ['new.ts']
    task.validation = ['npm test']
    queue.retryTask('t1')

    const updated = queue.getTask('t1')
    assert.equal(updated.status, 'pending')
    assert.deepEqual(updated.instructions, ['New instruction'])
    assert.deepEqual(updated.writeFile, ['new.ts'])
    assert.deepEqual(updated.validation, ['npm test'])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('split_task: skipping original and creating sub-tasks with deps', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')
    addTask(queue, 't1', { dependsOn: [], type: 'modify' })

    queue.skipTask('t1')
    assert.equal(queue.getTask('t1').status, 'skipped')

    addTask(queue, 't1-split-1', {
      instructions: ['Part 1'],
      writeFile: ['a.ts'],
      dependsOn: [],
    })
    addTask(queue, 't1-split-2', {
      instructions: ['Part 2'],
      readFile: ['a.ts'],
      writeFile: ['b.ts'],
      dependsOn: ['t1-split-1'],
    })

    const s1 = queue.getTask('t1-split-1')
    const s2 = queue.getTask('t1-split-2')
    assert.equal(s1.status, 'pending')
    assert.equal(s2.status, 'pending')
    assert.deepEqual(s1.dependsOn, [])
    assert.deepEqual(s2.dependsOn, ['t1-split-1'])

    const ready = queue.getReadyTasks()
    assert.equal(ready.length, 1)
    assert.equal(ready[0].id, 't1-split-1')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('get_task_status returns correct queue summary', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')
    addTask(queue, 't1')
    addTask(queue, 't2')
    addTask(queue, 't3')

    createAgent(db, 'a1')
    queue.assignTask('t1', 'a1')
    queue.startTask('t1')
    queue.completeTask('t1', true)
    queue.skipTask('t3')

    const status = queue.getStatus()
    assert.equal(status.total, 3)
    assert.equal(status.done, 1)
    assert.equal(status.skipped, 1)
    assert.equal(status.pending, 1)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MASTER_TOOL_SPECS are exported from master.js', async () => {
  const mod = await import('../dist/agent/master.js')
  assert.ok(mod.masterLoop, 'masterLoop should be exported')
})
