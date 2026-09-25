// Tests for TaskQueue — file overlap and dependency scenarios.
//
// Verifies that a task with the same file in both readFile and writeFile
// can still reach the 'running' state, and that dependencies gate readiness.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../dist/db/client.js'
import { TaskQueue } from '../dist/agent/taskqueue.js'

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-tq-overlap-'))
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

test('task with same file in readFile and writeFile reaches running', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')

    const state = queue.addTask({
      id: 'task-overlap',
      title: 'Overlap task',
      description: 'Reads and writes the same file',
      instructions: ['Edit the file'],
      readFile: ['src/api.ts'],
      writeFile: ['src/api.ts'],
      deleteFile: [],
      createDir: [],
      validation: [],
      dependsOn: [],
      type: 'modify',
      retries: 0,
      timeout: 120,
      rollback: [],
      skipIf: [],
    })
    assert.equal(state.status, 'pending')
    assert.deepEqual(state.readFile, ['src/api.ts'])
    assert.deepEqual(state.writeFile, ['src/api.ts'])

    const ready = queue.getReadyTasks()
    assert.equal(ready.length, 1)

    createAgent(db, 'agent-1')
    queue.assignTask('task-overlap', 'agent-1')
    assert.equal(queue.getTask('task-overlap').status, 'assigned')

    queue.startTask('task-overlap')
    assert.equal(queue.getTask('task-overlap').status, 'running')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default-permission task has null file and tool permissions', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')

    queue.addTask({
      id: 'task-default',
      title: 'Default task',
      description: null,
      instructions: ['Run validation'],
      readFile: [],
      writeFile: [],
      deleteFile: [],
      createDir: [],
      validation: ['echo "0 failures"'],
      dependsOn: [],
      type: 'modify',
      retries: 0,
      timeout: 120,
      rollback: [],
      skipIf: [],
    })

    const state = queue.getTask('task-default')
    assert.equal(state.filePermissions, null)
    assert.equal(state.toolPermissions, null)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dependent task is not ready until dependency completes', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')

    queue.addTask({
      id: 'task-1',
      title: 'First',
      description: null,
      instructions: [],
      readFile: [],
      writeFile: ['a.ts'],
      deleteFile: [],
      createDir: [],
      validation: [],
      dependsOn: [],
      type: 'create',
      retries: 0,
      timeout: 120,
      rollback: [],
      skipIf: [],
    })

    queue.addTask({
      id: 'task-2',
      title: 'Second',
      description: null,
      instructions: [],
      readFile: ['a.ts'],
      writeFile: [],
      deleteFile: [],
      createDir: [],
      validation: [],
      dependsOn: ['task-1'],
      type: 'modify',
      retries: 0,
      timeout: 120,
      rollback: [],
      skipIf: [],
    })

    let ready = queue.getReadyTasks()
    assert.equal(ready.length, 1)
    assert.equal(ready[0].id, 'task-1')

    createAgent(db, 'agent-1')
    queue.assignTask('task-1', 'agent-1')
    queue.startTask('task-1')
    queue.completeTask('task-1', true)

    ready = queue.getReadyTasks()
    assert.equal(ready.length, 1)
    assert.equal(ready[0].id, 'task-2')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skipped task unblocks dependents', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')

    queue.addTask({
      id: 'task-a',
      title: 'A',
      description: null,
      instructions: [],
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
    })

    queue.addTask({
      id: 'task-b',
      title: 'B',
      description: null,
      instructions: [],
      readFile: [],
      writeFile: [],
      deleteFile: [],
      createDir: [],
      validation: [],
      dependsOn: ['task-a'],
      type: 'modify',
      retries: 0,
      timeout: 120,
      rollback: [],
      skipIf: [],
    })

    queue.skipTask('task-a')
    assert.equal(queue.getTask('task-a').status, 'skipped')

    const ready = queue.getReadyTasks()
    assert.equal(ready.length, 1)
    assert.equal(ready[0].id, 'task-b')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retry resets task to pending and increments retry count', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')

    queue.addTask({
      id: 'task-retry',
      title: 'Retry',
      description: null,
      instructions: [],
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
    })

    createAgent(db, 'agent-1')
    queue.assignTask('task-retry', 'agent-1')
    queue.startTask('task-retry')
    assert.equal(queue.getTask('task-retry').retries, 0)

    queue.retryTask('task-retry')
    const state = queue.getTask('task-retry')
    assert.equal(state.status, 'pending')
    assert.equal(state.retries, 1)
    assert.equal(state.assignedAgentId, null)
    assert.equal(state.startedAt, null)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getStatus counts all statuses correctly', () => {
  const { db, dir } = scratchDb()
  try {
    const queue = new TaskQueue(db, 'session-1')

    const mk = (id) => ({
      id, title: id, description: null, instructions: [],
      readFile: [], writeFile: [], deleteFile: [], createDir: [],
      validation: [], dependsOn: [], type: 'modify', retries: 0,
      timeout: 120, rollback: [], skipIf: [],
    })

    queue.addTask(mk('t1'))
    queue.addTask(mk('t2'))
    queue.addTask(mk('t3'))
    queue.addTask(mk('t4'))
    queue.addTask(mk('t5'))

    createAgent(db, 'a1')
    createAgent(db, 'a2')
    queue.assignTask('t1', 'a1')
    queue.startTask('t1')
    queue.completeTask('t1', true)

    queue.assignTask('t2', 'a2')
    queue.startTask('t2')
    queue.failTask('t2')

    queue.skipTask('t3')

    const s = queue.getStatus()
    assert.equal(s.total, 5)
    assert.equal(s.done, 1)
    assert.equal(s.failed, 1)
    assert.equal(s.skipped, 1)
    assert.equal(s.pending, 2)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
