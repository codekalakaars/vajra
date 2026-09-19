// Tests for agent/master.ts — masterLoop and computeTaskPermissions.
//
// These tests exercise the master loop with mock providers and launchers
// to verify orchestration logic without network calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../dist/db/client.js'
import { AgentRegistry } from '../dist/agent/registry.js'

function scratchDb(name = 'proj-1') {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-master-'))
  const db = openDb(join(dir, 'test.db'))
  db.prepare(
    `INSERT INTO sessions (id, project_dir, task, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(name, dir, 'test', 'mock', 'starting', Date.now())
  return { db, dir }
}

function makeEvents() {
  const emitted = []
  return {
    emitted,
    push(event, projectId, payload) {
      emitted.push({ event, projectId, payload })
    },
  }
}

function mockProvider() {
  return {
    name: 'mock',
    async streamChat(req, onText) {
      onText('done')
      return {
        message: {
          role: 'assistant',
          content: 'Task complete',
          toolCalls: null,
        },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }
    },
  }
}

function mockLaunchWorker() {
  const calls = []
  return {
    calls,
    async launchWorker(job) {
      calls.push(job)
      return {
        async callTool(tool, args) {
          if (tool === 'run_command') return JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '' })
          return 'ok'
        },
        stop() {},
      }
    },
  }
}

test('masterLoop completes a single task with no dependencies', async () => {
  const { db, dir } = scratchDb()
  try {
    const registry = new AgentRegistry(db)
    const events = makeEvents()
    const { launchWorker, calls } = mockLaunchWorker()

    const { masterLoop } = await import('../dist/agent/master.js')

    const result = await masterLoop({
      projectId: 'proj-1',
      projectDir: dir,
      plan: {
        tasks: [{
          id: 'task-1',
          title: 'Single task',
          description: null,
          instructions: ['Do something'],
          readFile: ['src/a.ts'],
          writeFile: ['src/b.ts'],
          deleteFile: [],
          createDir: [],
          validation: [],
          dependsOn: [],
          type: 'modify',
          retries: 0,
          timeout: 120,
          rollback: [],
          skipIf: [],
        }],
        independentGroups: [['task-1']],
        estimatedWorkers: 1,
      },
      model: 'mock-model',
      apiKey: 'test-key',
      provider: mockProvider(),
      events,
      db,
      registry,
      launchWorker,
    })

    assert.equal(result.totalTasks, 1)
    assert.equal(result.completedTasks, 1)
    assert.equal(result.failedTasks, 0)
    assert.ok(calls.length >= 1, 'launchWorker was called at least once')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('masterLoop with validation command that succeeds', async () => {
  const { db, dir } = scratchDb('proj-2')
  try {
    const registry = new AgentRegistry(db)
    const events = makeEvents()
    const { launchWorker } = mockLaunchWorker()

    const { masterLoop } = await import('../dist/agent/master.js')

    const result = await masterLoop({
      projectId: 'proj-2',
      projectDir: dir,
      plan: {
        tasks: [{
          id: 'task-val',
          title: 'Task with validation',
          description: null,
          instructions: ['Do work'],
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
        }],
        independentGroups: [['task-val']],
        estimatedWorkers: 1,
      },
      model: 'mock-model',
      apiKey: 'test-key',
      provider: mockProvider(),
      events,
      db,
      registry,
      launchWorker,
    })

    assert.equal(result.completedTasks, 1)
    assert.equal(result.failedTasks, 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('masterLoop skips tasks when skipIf matches', async () => {
  const { db, dir } = scratchDb('proj-3')
  try {
    const registry = new AgentRegistry(db)
    const events = makeEvents()
    const { launchWorker, calls } = mockLaunchWorker()
  writeFileSync(join(dir, 'skip-me.ts'), 'skip\n')

    const { masterLoop } = await import('../dist/agent/master.js')

    const result = await masterLoop({
      projectId: 'proj-3',
      projectDir: dir,
      plan: {
        tasks: [{
          id: 'task-skip',
          title: 'Skippable task',
          description: null,
          instructions: ['Skip me'],
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
          skipIf: ['file exists: skip-me.ts'],
        }],
        independentGroups: [['task-skip']],
        estimatedWorkers: 1,
      },
      model: 'mock-model',
      apiKey: 'test-key',
      provider: mockProvider(),
      events,
      db,
      registry,
      launchWorker,
    })

    assert.equal(result.totalTasks, 1)
    assert.equal(result.completedTasks, 1, 'skipped tasks count as completed')
    assert.equal(result.failedTasks, 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
