import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { FileLockManager, resolveConcurrencyConfig } from '@codekalakaars/vajra-sandbox'

const serviceUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'session', 'service.js')).href
const persistUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'persist', 'index.js')).href
const queueUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'agent', 'taskqueue.js')).href
const {
  commandResourcePath,
  runSession,
  resolveMaxWorkers,
  withCommandResourceLock,
} = await import(serviceUrl)
const { hashFile, listSessions, loadSession } = await import(persistUrl)
const { TaskQueue } = await import(queueUrl)

const LATENCY_MS = 400

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Recording fake UI (mirrors session.test.mjs). */
function makeUI(promptAnswers = []) {
  const calls = []
  const answers = [...promptAnswers]
  const next = (kind, fallback = '') => {
    const answer = answers.shift()
    if (answer === undefined) throw new Error(`unexpected prompt: ${kind}`)
    return answer
  }
  const ui = {
    calls,
    banner: () => calls.push(['banner']),
    info: m => calls.push(['info', m]),
    success: m => calls.push(['success', m]),
    error: m => calls.push(['error', m]),
    warning: m => calls.push(['warning', m]),
    newline: () => calls.push(['newline']),
    onTextDelta: t => calls.push(['delta', t]),
    onThinkingDelta: t => calls.push(['thinking', t]),
    finishLine: () => calls.push(['finishLine']),
    discardBuffer: () => calls.push(['discardBuffer']),
    askInitialTask: kind => Promise.resolve(next(`initial:${kind}`)),
    askUserMessage: () => Promise.resolve(next('user')),
    showPlan: plan => calls.push(['plan', plan]),
    askConfirmPlan: () => Promise.resolve(next('confirm')),
    askRejectFeedback: () => Promise.resolve(next('feedback')),
    onTaskEvent: e => calls.push(['task', e]),
    onAgentEvent: e => calls.push(['agent', e]),
    text: () => calls.map(c => (typeof c[1] === 'string' ? c[1] : '')).join('\n'),
  }
  return ui
}

// --- stubbed provider -----------------------------------------------------
//
// runSession reaches the model through `streamChatCompletion`, which drives
// the OpenAI SDK's `fetch`. Replacing global fetch lets one test control the
// plan, the worker tool calls, and the wall clock of every round trip.

function sse(chunks) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function chunk(delta, finish = null) {
  return {
    id: 'stub-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stub-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function toolCallChunks(name, args) {
  return [
    chunk({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          index: 0,
          id: `call_${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    chunk({}, 'tool_calls'),
  ]
}

function finalChunks(text) {
  return [chunk({ role: 'assistant', content: text }), chunk({}, 'stop')]
}

async function readRequestBody(input, init) {
  let raw = init?.body
  if (raw == null && input && typeof input.text === 'function') raw = await input.text()
  if (raw == null) return {}
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

function workerReply(system, messages) {
  // A tool result already came back: finish the turn.
  if (messages.some(m => m.role === 'tool')) return sse(finalChunks('task complete'))
  const filesLine = (system.match(/FILES TO WRITE:\s*(.*)/) ?? [])[1] ?? ''
  const files = filesLine.trim()
  if (!files || files === '(none)') return sse(finalChunks('nothing to write'))
  const target = files.split(',')[0].trim()
  return sse(
    toolCallChunks('write_file', { path: target, content: `written by ${target}\n` }),
  )
}

function planArgs(planTasks) {
  return {
    summary: 'Concurrency batch plan',
    tasks: planTasks.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description ?? t.title,
      instructions: [],
      readFile: [],
      writeFile: t.writeFile ?? [],
      deleteFile: [],
      createDir: t.createDir ?? [],
      validation: t.validation ?? [],
      dependsOn: t.dependsOn ?? [],
      type: 'create',
      retries: 0,
      timeoutSeconds: 60,
    })),
  }
}

function createProvider({ planTasks, latencyMs = 0, workerReplyImpl = workerReply, developerReplyImpl }) {
  const stats = {
    active: 0,
    maxActive: 0,
    requests: 0,
    workerRequests: 0,
    firstWorkerAt: null,
    lastWorkerAt: null,
  }
  const request = async (input, init) => {
    stats.requests++
    stats.active++
    stats.maxActive = Math.max(stats.maxActive, stats.active)
    try {
      const body = await readRequestBody(input, init)
      const messages = Array.isArray(body.messages) ? body.messages : []
      const system = messages.find(m => m.role === 'system')?.content ?? ''
      if (latencyMs > 0) await sleep(latencyMs)
      if (system.startsWith('You are a worker agent')) {
        stats.workerRequests++
        const now = Date.now()
        if (stats.firstWorkerAt === null) stats.firstWorkerAt = now
        stats.lastWorkerAt = now
        return workerReplyImpl(system, messages)
      }
      return developerReplyImpl
        ? developerReplyImpl(system, messages)
        : sse(toolCallChunks('propose_plan', planArgs(planTasks)))
    } finally {
      stats.active--
    }
  }
  return { request, stats }
}

async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start runSession against a stubbed provider. `settle()` awaits the result
 * and restores global fetch; call it exactly once, including on the failure
 * path, so a hung run cannot leave the stub installed.
 */
function startSession({ projectDir, planTasks, latencyMs = LATENCY_MS, ui, signal, concurrency, timeoutMs = 45_000, workerReplyImpl, developerReplyImpl }) {
  const provider = createProvider({
    planTasks,
    latencyMs,
    ...(workerReplyImpl ? { workerReplyImpl } : {}),
    ...(developerReplyImpl ? { developerReplyImpl } : {}),
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = provider.request

  let forceClose = null
  const promise = runSession(
    {
      task: 'Run the concurrency plan',
      model: 'zen/test-model',
      apiKey: 'sk-test',
      projectDir,
      autoConfirm: true,
      allowUnenforced: true,
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(signal ? { signal } : {}),
      onSandboxClose: close => {
        if (close) forceClose = close
      },
    },
    ui,
  )
  // Mark handled so a late rejection is not reported as unhandled; `settle`
  // still surfaces it.
  let failed = false
  promise.catch(() => {
    failed = true
  })

  let settled = false
  const settle = async () => {
    if (settled) throw new Error('session already settled')
    settled = true
    try {
      return await withTimeout(promise, timeoutMs, 'runSession')
    } finally {
      globalThis.fetch = realFetch
    }
  }
  const hardStop = () => forceClose?.()
  return { provider, settle, hardStop, hasFailed: () => failed }
}

function latestSession(projectDir) {
  const list = listSessions(projectDir)
  if (list.length === 0) return null
  return loadSession(list[0].sessionId, projectDir)
}

function tempProject(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function task(id, title, extra = {}) {
  return { id, title, ...extra }
}

// --- tests ----------------------------------------------------------------

test('resolveMaxWorkers defaults to the config and honours the flag', () => {
  const configured = resolveConcurrencyConfig().maxConcurrentWorkers
  assert.equal(resolveMaxWorkers(), configured)
  assert.equal(resolveMaxWorkers(7), 7)
  assert.equal(resolveMaxWorkers(0), 1)
  assert.equal(resolveMaxWorkers(-3), 1)
  assert.equal(resolveMaxWorkers(2.9), 2)
  assert.equal(resolveMaxWorkers(Number.NaN), configured)
})

test('shared command resources serialise while unrelated resources stay parallel', async () => {
  assert.equal(commandResourcePath('git status'), 'resource:git')
  assert.equal(commandResourcePath('/usr/bin/npm install'), 'resource:node_modules')
  assert.equal(commandResourcePath('npx vitest'), 'resource:node_modules')
  assert.equal(commandResourcePath('ignored', ['git', 'status']), 'resource:git')
  assert.equal(commandResourcePath('pnpm install'), 'resource:node_modules')
  assert.equal(commandResourcePath('yarn install'), 'resource:node_modules')
  assert.equal(commandResourcePath('cargo build'), 'resource:cargo')
  assert.equal(commandResourcePath('node build.js'), null)

  const locks = new FileLockManager()
  let activeGit = 0
  let maxActiveGit = 0
  let activeTotal = 0
  let maxActiveTotal = 0
  const handle = {
    async callTool(_tool, args) {
      const command = String(args.command)
      activeTotal++
      maxActiveTotal = Math.max(maxActiveTotal, activeTotal)
      if (command.startsWith('git')) {
        activeGit++
        maxActiveGit = Math.max(maxActiveGit, activeGit)
      }
      try {
        await sleep(40)
        if (args.fail) throw new Error('command failed')
        return 'ok'
      } finally {
        if (command.startsWith('git')) activeGit--
        activeTotal--
      }
    },
  }

  const gitA = withCommandResourceLock(handle, locks, 'task-a')
  const gitB = withCommandResourceLock(handle, locks, 'task-b')
  const cargo = withCommandResourceLock(handle, locks, 'task-c')
  await Promise.all([
    gitA.callTool('run_command', { command: 'git status' }),
    gitB.callTool('run_command', { command: 'git diff' }),
    cargo.callTool('run_command', { command: 'cargo check' }),
  ])

  assert.equal(maxActiveGit, 1)
  assert.equal(maxActiveTotal, 2)

  await assert.rejects(
    gitA.callTool('run_command', { command: 'npm install', fail: true }),
    /command failed/,
  )
  assert.equal(
    await gitB.callTool('run_command', { command: 'pnpm install' }),
    'ok',
  )
})

test('TaskQueue.returnToPending undoes assignment without counting a retry', () => {
  const queue = new TaskQueue('session-1', 60)
  queue.addTask({
    id: 'a',
    title: 'A',
    description: null,
    instructions: [],
    readFile: [],
    writeFile: ['a.txt'],
    deleteFile: [],
    createDir: [],
    validation: [],
    dependsOn: [],
    type: 'create',
  })

  queue.assignTask('a', 'agent-1')
  queue.startTask('a')
  queue.returnToPending('a')

  let state = queue.getTask('a')
  assert.equal(state.status, 'pending')
  assert.equal(state.retries, 0, 'returning to pending is not a retry')
  assert.equal(state.startedAt, null)
  assert.equal(state.assignedAgentId, null)

  // Terminal states are never rewound.
  queue.completeTask('a')
  queue.returnToPending('a')
  state = queue.getTask('a')
  assert.equal(state.status, 'done')
  assert.ok(state.completedAt)
})

test('independent tasks run concurrently: time of the slowest, not the sum', async t => {
  const projectDir = tempProject('vajra-conc-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))

  const planTasks = [1, 2, 3, 4].map(i =>
    task(`t${i}`, `Write out-${i}.txt`, { writeFile: [`out-${i}.txt`] }),
  )
  const ui = makeUI()
  const session = startSession({ projectDir, planTasks, ui })

  let result
  try {
    result = await session.settle()
  } catch (e) {
    session.hardStop()
    throw e
  }

  assert.equal(result.exitCode, 0, ui.text())
  assert.equal(result.interrupted, false)

  // The provider must have had several round trips in flight at once.
  assert.ok(
    session.provider.stats.maxActive >= 3,
    `expected >=3 concurrent model requests, saw ${session.provider.stats.maxActive}`,
  )
  assert.equal(session.provider.stats.workerRequests, planTasks.length * 2)

  // Worker span: first model call issued → last one answered. Sequentially
  // that is tasks * 2 round trips; concurrently it is two round trips.
  const span = session.provider.stats.lastWorkerAt - session.provider.stats.firstWorkerAt
  const sequentialFloor = planTasks.length * 2 * LATENCY_MS
  assert.ok(
    span < sequentialFloor * 0.6,
    `worker span ${span}ms is too close to the sequential floor ${sequentialFloor}ms`,
  )

  for (const tsk of planTasks) {
    const file = join(projectDir, tsk.writeFile[0])
    assert.ok(existsSync(file), `${tsk.writeFile[0]} should exist`)
    assert.equal(readFileSync(file, 'utf-8'), `written by ${tsk.writeFile[0]}\n`)
  }

  const persisted = latestSession(projectDir)
  assert.ok(persisted, 'session should be persisted')
  for (const tsk of planTasks) {
    assert.equal(persisted.tasks[tsk.id].status, 'done')
    assert.equal(typeof persisted.tasks[tsk.id].completedAt, 'number')
    assert.equal(
      persisted.fileHashes[tsk.writeFile[0]],
      hashFile(join(projectDir, tsk.writeFile[0])),
    )
  }
})

test('a forced failure in one task leaves the others changes intact', async t => {
  const projectDir = tempProject('vajra-conc-fail-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))

  const planTasks = [
    task('ok-1', 'Write ok-1', { writeFile: ['ok-1.txt'] }),
    task('bad', 'Write bad then fail', {
      writeFile: ['bad.txt'],
      validation: ['node -e "process.exit(1)"'],
    }),
    task('ok-2', 'Write ok-2', { writeFile: ['ok-2.txt'] }),
  ]
  const ui = makeUI()
  const session = startSession({ projectDir, planTasks, ui, latencyMs: 100 })

  let result
  try {
    result = await session.settle()
  } catch (e) {
    session.hardStop()
    throw e
  }

  assert.notEqual(result.exitCode, 0, ui.text())

  // Survivors keep their writes.
  assert.ok(existsSync(join(projectDir, 'ok-1.txt')))
  assert.equal(readFileSync(join(projectDir, 'ok-1.txt'), 'utf-8'), 'written by ok-1.txt\n')
  assert.ok(existsSync(join(projectDir, 'ok-2.txt')))
  assert.equal(readFileSync(join(projectDir, 'ok-2.txt'), 'utf-8'), 'written by ok-2.txt\n')
  // The failing task was rolled back.
  assert.ok(!existsSync(join(projectDir, 'bad.txt')), 'bad.txt must be rolled back')

  const persisted = latestSession(projectDir)
  assert.ok(persisted, 'session should be persisted')
  assert.equal(persisted.tasks['ok-1'].status, 'done')
  assert.equal(persisted.tasks['ok-2'].status, 'done')
  assert.equal(persisted.tasks['bad'].status, 'failed')
  assert.ok(persisted.tasks['bad'].completedAt, 'failure is recorded before the run ends')
})

test('a task that throws releases its locks and settles dependent work', async t => {
  const projectDir = tempProject('vajra-conc-lock-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))

  // `../escape.txt` resolves outside the project, so ChangeHistory.recordBefore
  // throws after this task acquires the write lock. The dependent task must
  // still be able to proceed after the finally-release.
  const planTasks = [
    task('escape', 'Write outside the project', { writeFile: ['../escape-target.txt'] }),
    task('waiter', 'Create the same path', {
      createDir: ['../escape-target.txt'],
      dependsOn: ['escape'],
    }),
  ]
  const ui = makeUI()
  const session = startSession({ projectDir, planTasks, ui, latencyMs: 100, timeoutMs: 30_000 })

  let result
  try {
    result = await session.settle()
  } catch (e) {
    session.hardStop()
    throw e
  }

  assert.notEqual(result.exitCode, 0, ui.text())

  const persisted = latestSession(projectDir)
  assert.ok(persisted, 'session should be persisted')
  assert.equal(persisted.tasks.escape.status, 'failed')
  assert.match(persisted.tasks.escape.error ?? '', /outside project directory/)
  assert.equal(persisted.tasks.waiter.status, 'skipped')
})

test('interrupt leaves a persisted record of what completed', async t => {
  const projectDir = tempProject('vajra-conc-int-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))

  const planTasks = Array.from({ length: 8 }, (_, i) =>
    task(`t${i + 1}`, `Write out-${i + 1}.txt`, { writeFile: [`out-${i + 1}.txt`] }),
  )
  const controller = new AbortController()
  const ui = makeUI()
  // concurrency 2: at least half the plan must still be pending when we stop.
  const session = startSession({
    projectDir,
    planTasks,
    ui,
    latencyMs: 500,
    concurrency: 2,
    signal: controller.signal,
  })

  // Wait until at least one task has finished, then interrupt.
  const deadline = Date.now() + 30_000
  let sawDone = false
  while (Date.now() < deadline && !sawDone && !session.hasFailed()) {
    const s = latestSession(projectDir)
    if (s && Object.values(s.tasks).some(t => t.status === 'done')) sawDone = true
    else await sleep(25)
  }
  controller.abort()

  let result
  try {
    result = await session.settle()
  } catch (e) {
    session.hardStop()
    throw e
  }

  assert.ok(sawDone, 'a task should have completed before the interrupt')
  assert.equal(result.interrupted, true)
  // Pending work after an interrupt forces a non-zero report code (D5).
  assert.notEqual(result.exitCode, 0)

  const persisted = latestSession(projectDir)
  assert.ok(persisted, 'interrupted run must leave a persisted session')

  const statuses = Object.values(persisted.tasks).map(t => t.status)
  assert.ok(statuses.filter(s => s === 'done').length >= 1, 'completed work is recorded')
  assert.ok(statuses.includes('pending'), 'unscheduled work is recorded as pending')
  assert.ok(
    !statuses.includes('running') && !statuses.includes('assigned'),
    `no task may be left mid-flight in the record: ${statuses.join(', ')}`,
  )

  // Completed tasks actually landed on disk — and a task recorded as done
  // must never be one that was interrupted before it wrote anything.
  const written = planTasks
    .map(t => t.writeFile[0])
    .filter(f => existsSync(join(projectDir, f)))
  assert.ok(written.length >= 1, 'at least one completed file survives the interrupt')
  for (const tsk of planTasks) {
    if (persisted.tasks[tsk.id].status !== 'done') continue
    assert.ok(
      existsSync(join(projectDir, tsk.writeFile[0])),
      `${tsk.id} is recorded done but ${tsk.writeFile[0]} is missing`,
    )
  }
})

test('a turn that only makes tool calls still reports continuous activity', async t => {
  const projectDir = tempProject('vajra-vis-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))

  // A slow provider + a slow tool: the two windows §1 exists to cover.
  const planTasks = [task('v1', 'Write vis-1.txt', { writeFile: ['vis-1.txt'] })]
  const ui = makeUI()
  const session = startSession({ projectDir, planTasks, ui, latencyMs: 900 })

  let result
  try {
    result = await session.settle()
  } catch (e) {
    session.hardStop()
    throw e
  }
  assert.equal(result.exitCode, 0, ui.text())

  const events = ui.calls.filter(c => c[0] === 'agent').map(c => c[1])
  assert.ok(events.length > 0, 'the session emitted no agent activity at all')

  // The provider round-trip is bracketed even though no prose was produced.
  const starts = events.filter(e => e.type === 'llm-start')
  const ends = events.filter(e => e.type === 'llm-end')
  assert.equal(starts.length, ends.length, 'every llm-start must be closed by an llm-end')
  assert.ok(starts.length >= 2, `expected a planning round and a worker round, saw ${starts.length}`)

  // Heartbeats are what keep the screen moving through a slow call.
  const beats = events.filter(e => e.type === 'heartbeat')
  assert.ok(beats.length >= 1, 'a ~2s run emitted no heartbeat — the screen would look dead')

  // Every tool call is bracketed, and attributed.
  const toolStarts = events.filter(e => e.type === 'tool-start')
  const toolEnds = events.filter(e => e.type === 'tool-end')
  assert.equal(toolStarts.length, toolEnds.length, 'a tool-start was left dangling')
  assert.ok(toolStarts.some(e => e.tool === 'propose_plan'), 'plan proposal was not reported')
  assert.ok(
    toolEnds.some(e => e.agent.taskId === 'v1' && e.tool === 'write_file'),
    'the worker tool call was not attributed to its task',
  )

  // Nothing on the wire leaks file contents.
  const text = JSON.stringify(events)
  assert.ok(!text.includes('written by vis-1.txt'), 'a tool detail leaked file content')
  assert.ok(!text.includes('/tmp/'), `an absolute path leaked: ${text}`)
})

test('a masked file is reported as masked, never with its contents', async t => {
  const projectDir = tempProject('vajra-mask-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  writeFileSync(join(projectDir, '.env'), 'OPENCODE_API_KEY=sk-super-secret\n', 'utf-8')

  const planTasks = [task('m1', 'Write mask-1.txt', { writeFile: ['mask-1.txt'] })]
  const ui = makeUI()
  const session = startSession({
    projectDir,
    planTasks,
    ui,
    // The developer asks for .env, gets the derived stub back, then plans.
    developerReplyImpl: (system, messages) =>
      messages.some(m => m.role === 'tool')
        ? sse(toolCallChunks('propose_plan', planArgs(planTasks)))
        : sse(toolCallChunks('read_file', { path: '.env' })),
  })

  let result
  try {
    result = await session.settle()
  } catch (e) {
    session.hardStop()
    throw e
  }
  assert.equal(result.exitCode, 0, ui.text())

  const events = ui.calls.filter(c => c[0] === 'agent').map(c => c[1])
  const readEnd = events.find(e => e.type === 'tool-end' && e.tool === 'read_file')
  assert.ok(readEnd, 'read_file completion was not reported')
  assert.ok(
    readEnd.detail === 'masked' || /\d+(\.\d+)? (B|KB|MB)/.test(readEnd.detail),
    `unexpected detail: ${readEnd.detail}`,
  )
  const text = JSON.stringify(events)
  assert.ok(!text.includes('sk-super-secret'), 'a secret reached the event stream')
  assert.ok(
    !text.includes('REDACTED'),
    'the masked stub text reached the event stream — only the word "masked" should',
  )
  // The path itself is fine, and useful: you should see *which* file was read.
  assert.match(text, /\.env/)
})
