import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const executeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tasks', 'execute.js')).href
const developerUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'agent', 'developer.js')).href
const { executeTask } = await import(executeUrl)
const { developerConversationTurn } = await import(developerUrl)

const READ_LATENCY = 300

function tempProject(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** A provider stub that returns a scripted list of tool-call messages. */
function scriptedProvider(script) {
  const realFetch = globalThis.fetch
  const state = { turn: 0 }
  const encoder = new TextEncoder()
  globalThis.fetch = async () => {
    const calls = script[Math.min(state.turn, script.length - 1)]
    state.turn++
    const body = new ReadableStream({
      start(controller) {
        // Distinct `index` per call: the SDK assembles streamed tool calls by
        // index, so reusing 0 would merge them into one.
        calls.forEach((call, i) => {
          const chunk = {
            id: 's',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'm',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      index: i,
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return {
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

const noopStreamer = {
  onTextDelta() {},
  onThinkingDelta() {},
  finishLine() {},
  discardBuffer() {},
  info() {},
  success() {},
  error() {},
  warning() {},
  newline() {},
}

const TASK = {
  id: 't1',
  title: 'Inspect the tree',
  description: null,
  instructions: ['read the files'],
  readFile: ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
  writeFile: [],
  deleteFile: [],
  createDir: [],
  validation: [],
  timeoutSeconds: 60,
  maxRetries: 0,
  rollback: [],
  skipIf: [],
}

/** A handle that records overlap and answers reads after a fixed latency. */
function slowHandle(files, log) {
  return {
    async callTool(name, args) {
      log.calls.push({ name, args, at: Date.now() })
      if (name === 'read_file') {
        log.active++
        log.maxActive = Math.max(log.maxActive, log.active)
        await sleep(READ_LATENCY)
        log.active--
        return `contents of ${args.path}`
      }
      return 'ok'
    },
  }
}

test('the worker runs one message of read_file calls concurrently', async t => {
  const projectDir = tempProject('vajra-p2-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  for (const f of TASK.readFile) writeFileSync(join(projectDir, f), 'x\n', 'utf-8')

  const log = { calls: [], active: 0, maxActive: 0 }
  const provider = scriptedProvider([
    TASK.readFile.map((path, i) => ({ id: `r${i}`, name: 'read_file', args: { path } })),
    [],
  ])
  t.after(() => provider.restore())

  const started = Date.now()
  const ok = await executeTask(
    'agent-1',
    TASK,
    slowHandle(TASK.readFile, log),
    'sk-test',
    'zen/test-model',
    noopStreamer,
    null,
    null,
    null,
    'session-1',
    null,
    projectDir,
  )
  const elapsed = Date.now() - started

  assert.equal(ok, true)
  assert.equal(log.calls.length, 4)
  assert.equal(log.maxActive, 4, `expected 4 overlapping reads, peak was ${log.maxActive}`)
  // Serial execution would be 4 x READ_LATENCY.
  assert.ok(elapsed < READ_LATENCY * 2.5, `took ${elapsed}ms — not overlapped`)
})

test('tool results are appended in the model order, not completion order', async t => {
  const projectDir = tempProject('vajra-p2o-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  for (const f of TASK.readFile) writeFileSync(join(projectDir, f), 'x\n', 'utf-8')

  const log = { calls: [], active: 0, maxActive: 0 }
  const provider = scriptedProvider([
    TASK.readFile.map((path, i) => ({ id: `r${i}`, name: 'read_file', args: { path } })),
    [],
  ])
  t.after(() => provider.restore())

  // Capture the messages the worker assembles.
  const seen = []
  const streamer = { ...noopStreamer }
  const handle = slowHandle(TASK.readFile, log)
  const originalCall = handle.callTool.bind(handle)
  handle.callTool = async (name, args) => {
    // Later files answer first, so completion order is the reverse of the
    // model's order — exactly the case that corrupts a provider conversation.
    await sleep(READ_LATENCY * (TASK.readFile.length - TASK.readFile.indexOf(args.path)))
    seen.push(args.path)
    return originalCall(name, args)
  }

  await executeTask(
    'agent-1',
    TASK,
    handle,
    'sk-test',
    'zen/test-model',
    streamer,
    null,
    null,
    null,
    'session-1',
    null,
    projectDir,
  )
  assert.deepEqual(seen.slice().reverse(), TASK.readFile, 'completion order was not reversed')
})

test('mutating tools keep their original order', async t => {
  const projectDir = tempProject('vajra-p2m-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))

  const order = []
  const log = { calls: [], active: 0, maxActive: 0 }
  const provider = scriptedProvider([
    [
      { id: 'w1', name: 'write_file', args: { path: 'one.txt', content: '1' } },
      { id: 'w2', name: 'write_file', args: { path: 'two.txt', content: '2' } },
      { id: 'w3', name: 'write_file', args: { path: 'three.txt', content: '3' } },
    ],
    [],
  ])
  t.after(() => provider.restore())

  const handle = {
    async callTool(name, args) {
      order.push(args.path)
      await sleep(10)
      return 'ok'
    },
  }

  await executeTask(
    'agent-1',
    { ...TASK, readFile: [], writeFile: ['one.txt', 'two.txt', 'three.txt'] },
    handle,
    'sk-test',
    'zen/test-model',
    noopStreamer,
    null,
    null,
    null,
    'session-1',
    null,
    projectDir,
  )
  assert.deepEqual(order, ['one.txt', 'two.txt', 'three.txt'])
})

test('a mutating call is not overlapped with a read in the same message', async t => {
  const projectDir = tempProject('vajra-p2x-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))

  const log = { calls: [], active: 0, maxActive: 0 }
  const provider = scriptedProvider([
    [
      { id: 'r1', name: 'read_file', args: { path: 'a.txt' } },
      { id: 'r2', name: 'read_file', args: { path: 'b.txt' } },
      { id: 'w1', name: 'write_file', args: { path: 'c.txt', content: 'x' } },
    ],
    [],
  ])
  t.after(() => provider.restore())

  const handle = slowHandle(null, log)
  await executeTask(
    'agent-1',
    { ...TASK, readFile: ['a.txt', 'b.txt'], writeFile: ['c.txt'] },
    handle,
    'sk-test',
    'zen/test-model',
    noopStreamer,
    null,
    null,
    null,
    'session-1',
    null,
    projectDir,
  )
  // The two reads may overlap; the write must not have joined them.
  assert.equal(log.maxActive, 2)
  assert.deepEqual(log.calls.map(c => c.name), ['read_file', 'read_file', 'write_file'])
})

test('the developer runs a message of reads concurrently too', async t => {
  const projectDir = tempProject('vajra-p2d-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(projectDir, f), 'export const x = 1\n', 'utf-8')

  const log = { calls: [], active: 0, maxActive: 0 }
  const provider = scriptedProvider([
    [
      { id: 'd1', name: 'read_file', args: { path: 'a.ts' } },
      { id: 'd2', name: 'read_file', args: { path: 'b.ts' } },
      { id: 'd3', name: 'read_file', args: { path: 'c.ts' } },
    ],
    [],
  ])
  t.after(() => provider.restore())

  const started = Date.now()
  const result = await developerConversationTurn({
    sessionId: 'session-1',
    projectDir,
    userMessage: 'look around',
    model: 'zen/test-model',
    apiKey: 'sk-test',
    handle: slowHandle(null, log),
    messages: [],
    summaryIndex: [],
  })
  const elapsed = Date.now() - started

  assert.equal(result.type, 'response')
  assert.equal(log.maxActive, 3, `expected 3 overlapping reads, peak was ${log.maxActive}`)
  assert.ok(elapsed < READ_LATENCY * 2.5, `took ${elapsed}ms — not overlapped`)
})
