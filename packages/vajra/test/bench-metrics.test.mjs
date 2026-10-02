import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const { createBenchRecorder } = await import(
  pathToFileURL(join(root, 'bench', 'metrics.js')).href
)
const { TODAYS_PARAMS } = await import(pathToFileURL(join(root, 'bench', 'params.js')).href)

/**
 * A clock the test owns. The recorder has no other source of time, so every
 * event below lands on the millisecond it is written to say it did.
 */
function fakeClock() {
  const clock = { at: 0 }
  clock.now = () => clock.at
  return clock
}

function recorderFor(tasks, overrides = {}, clock = fakeClock()) {
  return createBenchRecorder({
    suite: 'test',
    config: { ...TODAYS_PARAMS, ...overrides },
    tasks,
    now: clock.now,
  })
}

/** Feed a scripted stream: `[epochMs, stream, event]` triples, in order. */
function drive(recorder, clock, script) {
  for (const [at, stream, event] of script) {
    clock.at = at
    recorder[stream](event)
  }
}

const task = (id, over = {}) => ({ id, title: `Task ${id}`, ...over })

/**
 * The context fields every task result carries, for the run with every context
 * switch off: nothing was compiled, nothing was cut, and nothing was looked for.
 * Written once so a run of `deepEqual` on whole task results stays about the
 * fields a test is actually about.
 */
const NO_CONTEXT = {
  packTokens: 0,
  packSectionsCut: 0,
  packPaths: [],
  staleAnchors: 0,
  relocatedAnchors: 0,
  seeks: 0,
  seekRatio: 0,
  redundantReads: 0,
  roundsToFirstEdit: null,
  elisions: 0,
  compactions: 0,
  stuck: 0,
}

const worker = (id, title = `Task ${id}`) => ({ role: 'worker', taskId: id, title })
// Task events carry the id; every task here is titled `Task <id>`.
const idOf = title => title.replace(/^Task /, '')
const start = title => ({ type: 'start', taskId: idOf(title), index: 0, total: 1, title })
const done = title => ({ type: 'done', taskId: idOf(title), title })
const failed = title => ({ type: 'failed', taskId: idOf(title), title })
const skipped = title => ({ type: 'skipped', taskId: idOf(title), title })
const retry = title => ({ type: 'retry', taskId: idOf(title), title, attempt: 1, max: 2 })
const llmStart = (id, round = 1) => ({ type: 'llm-start', agent: worker(id), round })
const toolStart = (id, callId = 'c1') => ({
  type: 'tool-start',
  agent: worker(id),
  callId,
  tool: 'write_file',
  summary: 'a.txt',
})

// --- the two waves ------------------------------------------------------

test('a two-wave stream measures the wall, the floor under it, and the idle in it', () => {
  const tasks = [
    task('t1', { writeFile: ['a.txt'] }),
    task('t2', { writeFile: ['b.txt'] }),
    task('t3', { writeFile: ['c.txt'], dependsOn: ['t1'] }),
  ]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, {}, clock)

  // Wave one: t1 and t2 are both ready at the first spawn, but one Worker runs
  // them, so t2 waits 200ms for a slot. Wave two: t3 is ready the moment t1
  // lands, and waits 100ms behind t2 for the same slot.
  drive(recorder, clock, [
    [1000, 'taskEvent', start('Task t1')],
    [1000, 'agentEvent', llmStart('t1')],
    [1100, 'agentEvent', toolStart('t1')],
    [1200, 'taskEvent', done('Task t1')],
    [1200, 'taskEvent', start('Task t2')],
    [1300, 'taskEvent', done('Task t2')],
    [1300, 'taskEvent', start('Task t3')],
    [1500, 'taskEvent', done('Task t3')],
  ])

  const result = recorder.result({ success: true })

  assert.equal(result.wallMs, 500)
  // t1 → t3: a dependency, so 200 + 200ms. No arrangement beats that; the 100ms
  // t2 spent running is the only slack in the 500ms.
  assert.equal(result.criticalPathMs, 400)
  // 200ms waiting for a slot, plus 100ms for the same reason.
  assert.equal(result.idleMs, 300)

  assert.deepEqual(result.tasks, [
    {
      id: 't1',
      title: 'Task t1',
      readyAt: 1000,
      startedAt: 1000,
      endedAt: 1200,
      status: 'done',
      attempts: 1,
      modelRounds: 1,
      slowestRoundMs: 0,
      toolCalls: 1,
      pausedMs: 0,
      peakPromptTokens: 0,
      peakContextShare: 0,
      contextTrims: 0,
      ...NO_CONTEXT,
      // t1's only call was the write itself, one round in.
      roundsToFirstEdit: 1,
    },
    {
      id: 't2',
      title: 'Task t2',
      readyAt: 1000,
      startedAt: 1200,
      endedAt: 1300,
      status: 'done',
      attempts: 1,
      modelRounds: 0,
      slowestRoundMs: 0,
      toolCalls: 0,
      pausedMs: 0,
      peakPromptTokens: 0,
      peakContextShare: 0,
      contextTrims: 0,
      ...NO_CONTEXT,
    },
    {
      id: 't3',
      title: 'Task t3',
      readyAt: 1200,
      startedAt: 1300,
      endedAt: 1500,
      status: 'done',
      attempts: 1,
      modelRounds: 0,
      slowestRoundMs: 0,
      toolCalls: 0,
      pausedMs: 0,
      peakPromptTokens: 0,
      peakContextShare: 0,
      contextTrims: 0,
      ...NO_CONTEXT,
    },
  ])
})

// --- the floor ----------------------------------------------------------

test('same-file tasks are a chain under exclusive locks, whichever way they were ordered', () => {
  const tasks = [
    task('t2', { writeFile: ['shared.txt'] }),
    task('t1', { writeFile: ['shared.txt'] }),
  ]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, { readLocks: 'exclusive' }, clock)

  // t1 runs first even though the plan lists t2 first: the chain follows the
  // order the run serialised them in, not the order the plan wrote them down.
  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [100, 'taskEvent', done('Task t1')],
    [100, 'taskEvent', start('Task t2')],
    [400, 'taskEvent', done('Task t2')],
  ])

  const result = recorder.result({ success: true })
  assert.equal(result.wallMs, 400)
  assert.equal(result.criticalPathMs, 400)
  // t2 waited out t1's lock on a file both of them write. No lock mode and no
  // slot count overlaps two writers, so that wait is not idle: t2 was ready
  // only when t1 let go.
  assert.equal(result.idleMs, 0)
  // Plan order is preserved in the record, so a result diffs cleanly against
  // the plan it came from.
  assert.deepEqual(result.tasks.map(t => t.id), ['t2', 't1'])
})

test('shared read locks lift two readers of one file out of the chain', () => {
  const tasks = [
    task('t1', { readFile: ['shared.txt'] }),
    task('t2', { readFile: ['shared.txt'] }),
  ]
  const script = [
    [0, 'taskEvent', start('Task t1')],
    [100, 'taskEvent', done('Task t1')],
    [100, 'taskEvent', start('Task t2')],
    [400, 'taskEvent', done('Task t2')],
  ]

  const clock = fakeClock()
  const exclusive = recorderFor(tasks, { readLocks: 'exclusive' }, clock)
  drive(exclusive, clock, script)
  // Exclusive locks every path for writing, read files included: 100 + 300.
  assert.equal(exclusive.result({ success: true }).criticalPathMs, 400)

  const sharedClock = fakeClock()
  const shared = recorderFor(tasks, { readLocks: 'shared' }, sharedClock)
  drive(shared, sharedClock, script)
  // Under `shared` nothing forces them apart, so the floor is the slower one.
  assert.equal(shared.result({ success: true }).criticalPathMs, 300)
})

test('a dependency chain is a floor even when the tasks shared no file', () => {
  const tasks = [
    task('t1', { writeFile: ['a.txt'] }),
    task('t2', { writeFile: ['b.txt'], dependsOn: ['t1'] }),
    task('t3', { writeFile: ['c.txt'], dependsOn: ['t2'] }),
  ]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [100, 'taskEvent', done('Task t1')],
    [100, 'taskEvent', start('Task t2')],
    [250, 'taskEvent', done('Task t2')],
    [250, 'taskEvent', start('Task t3')],
    [300, 'taskEvent', done('Task t3')],
  ])

  const result = recorder.result({ success: true })
  assert.equal(result.criticalPathMs, 300)
  assert.equal(result.idleMs, 0)
})

// --- attempts, failures and idle ---------------------------------------

test('a retry is a second attempt inside one task, and does not move its start', () => {
  const tasks = [task('t1', { writeFile: ['a.txt'] })]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [50, 'agentEvent', llmStart('t1', 1)],
    [60, 'taskEvent', { type: 'no-changes', title: 'Task t1' }],
    [70, 'taskEvent', retry('Task t1')],
    [80, 'taskEvent', start('Task t1')],
    [80, 'agentEvent', llmStart('t1', 1)],
    [90, 'agentEvent', toolStart('t1', 'c1')],
    [150, 'taskEvent', done('Task t1')],
  ])

  const result = recorder.result({ success: true })
  const [t1] = result.tasks
  assert.equal(t1.attempts, 2)
  assert.equal(t1.modelRounds, 2)
  assert.equal(t1.toolCalls, 1)
  // The duration covers both attempts and the gap between them: that is the
  // span whatever depended on t1 actually waited through.
  assert.equal(t1.startedAt, 0)
  assert.equal(t1.endedAt, 150)
  assert.equal(result.wallMs, 150)
})

test('a failed dependency leaves its dependent unready, and idle empty', () => {
  const tasks = [
    task('t1', { writeFile: ['a.txt'] }),
    task('t2', { writeFile: ['b.txt'], dependsOn: ['t1'] }),
  ]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [100, 'taskEvent', failed('Task t1')],
  ])

  const result = recorder.result({ success: false, failureReason: 't1 failed' })
  assert.equal(result.success, false)
  assert.equal(result.failureReason, 't1 failed')
  assert.equal(result.idleMs, 0)
  // t2 never became ready, so there is no wait to charge the arrangement for.
  assert.equal(result.tasks[1].status, 'pending')
  assert.equal('readyAt' in result.tasks[1], false)
  assert.equal('endedAt' in result.tasks[1], false)
})

test('a skipped task settles its dependents, so they can be ready', () => {
  const tasks = [
    task('t1', { writeFile: ['a.txt'] }),
    task('t2', { writeFile: ['b.txt'], dependsOn: ['t1'] }),
  ]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [100, 'taskEvent', skipped('Task t1')],
    [200, 'taskEvent', start('Task t2')],
    [300, 'taskEvent', done('Task t2')],
  ])

  const result = recorder.result({ success: true })
  assert.equal(result.tasks[0].status, 'skipped')
  assert.equal(result.tasks[1].readyAt, 100)
  assert.equal(result.idleMs, 100)
  assert.equal(result.wallMs, 300)
})

// --- the ends of the stream --------------------------------------------

test('a run that spawned nothing measures nothing, and does not throw', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1'), task('t2')], {}, clock)
  const result = recorder.result({ success: false, failureReason: 'no tasks ran' })

  assert.equal(result.wallMs, 0)
  assert.equal(result.criticalPathMs, 0)
  assert.equal(result.idleMs, 0)
  assert.deepEqual(result.tasks, [
    { id: 't1', title: 'Task t1', status: 'pending', attempts: 0, modelRounds: 0, slowestRoundMs: 0, toolCalls: 0, pausedMs: 0, peakPromptTokens: 0, peakContextShare: 0, contextTrims: 0, ...NO_CONTEXT },
    { id: 't2', title: 'Task t2', status: 'pending', attempts: 0, modelRounds: 0, slowestRoundMs: 0, toolCalls: 0, pausedMs: 0, peakPromptTokens: 0, peakContextShare: 0, contextTrims: 0, ...NO_CONTEXT },
  ])
})

test('a task still in flight when the run stops is not a completion', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1')], {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [100, 'agentEvent', llmStart('t1')],
  ])

  const result = recorder.result({ success: false, failureReason: 'interrupted' })
  // No task completed, so there is no wall to measure — the run has no score.
  assert.equal(result.wallMs, 0)
  // The chain is still charged to the last thing the run said, so the floor
  // stays a lower bound instead of collapsing to nothing.
  assert.equal(result.criticalPathMs, 100)
  assert.equal(result.tasks[0].status, 'pending')
})

test('events that belong to no measured task are ignored', () => {
  const tasks = [task('t1', { writeFile: ['a.txt'] })]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, {}, clock)

  drive(recorder, clock, [
    // The Developer, an event for a task outside the plan, and a title the plan
    // does not use: none of them may open an attempt or start the clock.
    [50, 'agentEvent', { type: 'llm-start', agent: { role: 'developer' }, round: 1 }],
    [60, 'agentEvent', { type: 'tool-start', agent: worker('t9'), callId: 'c9', tool: 'write_file', summary: '' }],
    [70, 'taskEvent', start('Task unknown')],
    [80, 'taskEvent', done('Task unknown')],
  ])
  const before = recorder.result({ success: false })
  assert.equal(before.wallMs, 0)
  assert.equal(before.tasks[0].attempts, 0)
  assert.equal(before.criticalPathMs, 0)

  drive(recorder, clock, [
    [100, 'taskEvent', start('Task t1')],
    [200, 'taskEvent', done('Task t1')],
  ])
  const after = recorder.result({ success: true })
  assert.equal(after.wallMs, 100)
  assert.equal(after.tasks[0].status, 'done')
})

test('the result names the suite and copies the config it ran with', () => {
  const config = { ...TODAYS_PARAMS, concurrency: 8, workerModel: 'zen/space-bunny-free' }
  const clock = fakeClock()
  const recorder = createBenchRecorder({
    suite: 'fan',
    config,
    tasks: [task('t1')],
    now: clock.now,
  })

  const result = recorder.result({ success: true })
  assert.equal(result.suite, 'fan')
  assert.deepEqual(result.config, config)
  // A copy, so a consumer writing the result cannot reach back into the config
  // the next repetition reads.
  assert.notEqual(result.config, config)
  assert.equal('failureReason' in result, false)
})

// --- what the fixes pin --------------------------------------------------

test('two tasks with one title are measured as two tasks', () => {
  const tasks = [
    { id: 'a', title: 'Same title', writeFile: ['a.txt'] },
    { id: 'b', title: 'Same title', writeFile: ['b.txt'] },
  ]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, { concurrency: 2 }, clock)
  drive(recorder, clock, [
    [1000, 'taskEvent', { type: 'start', taskId: 'a', index: 1, total: 2, title: 'Same title' }],
    [1000, 'taskEvent', { type: 'start', taskId: 'b', index: 2, total: 2, title: 'Same title' }],
    [1100, 'taskEvent', { type: 'done', taskId: 'b', title: 'Same title' }],
    [1300, 'taskEvent', { type: 'done', taskId: 'a', title: 'Same title' }],
  ])
  const result = recorder.result({ success: true })
  assert.deepEqual(
    result.tasks.map(t => [t.id, t.startedAt, t.endedAt, t.status]),
    [['a', 1000, 1300, 'done'], ['b', 1000, 1100, 'done']],
  )
})

test('waiting on a file another task holds is not idle', () => {
  // Same file, exclusive locks: t2 cannot start until t1 lets go, however many
  // slots are free, so the 200ms it waited is not the arrangement's to recover.
  const tasks = [task('t1', { writeFile: ['src/a.js'] }), task('t2', { writeFile: ['./src/a.js'] })]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, { concurrency: 4 }, clock)
  drive(recorder, clock, [
    [1000, 'taskEvent', start('Task t1')],
    [1200, 'taskEvent', done('Task t1')],
    [1200, 'taskEvent', start('Task t2')],
    [1300, 'taskEvent', done('Task t2')],
  ])
  const result = recorder.result({ success: true })
  assert.equal(result.idleMs, 0)
  assert.equal(result.tasks[1].readyAt, 1200)
  // Two spellings of one file are one file: the pair is a chain.
  assert.equal(result.criticalPathMs, 300)
})

test('time a task spends waiting only for a slot is still idle', () => {
  const tasks = [task('t1', { writeFile: ['a.txt'] }), task('t2', { writeFile: ['b.txt'] })]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, { concurrency: 1 }, clock)
  drive(recorder, clock, [
    [1000, 'taskEvent', start('Task t1')],
    [1200, 'taskEvent', done('Task t1')],
    [1200, 'taskEvent', start('Task t2')],
    [1300, 'taskEvent', done('Task t2')],
  ])
  assert.equal(recorder.result({ success: true }).idleMs, 200)
})

test('a pause is timed from the paused phase to the phase the Worker resumes into', () => {
  const tasks = [task('t1', { writeFile: ['a.txt'] })]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, {}, clock)
  const phase = phase => ({ type: 'phase', agent: worker('t1'), phase })
  drive(recorder, clock, [
    [1000, 'taskEvent', start('Task t1')],
    [1000, 'agentEvent', phase('executing')],
    [1100, 'agentEvent', phase('paused')],
    [1400, 'agentEvent', phase('executing')],
    [1500, 'agentEvent', phase('paused')],
    [1600, 'taskEvent', done('Task t1')],
  ])
  const result = recorder.result({ success: true })
  assert.equal(result.tasks[0].pausedMs, 400)
  assert.equal(result.pausedMs, 400)
  // Paused time is still the task's time: the floor includes it.
  assert.equal(result.criticalPathMs, 600)
})

test('the fullest prompt and every trim are recorded per task and for the run', () => {
  const tasks = [task('t1', { writeFile: ['a.txt'] }), task('t2', { writeFile: ['b.txt'] })]
  const clock = fakeClock()
  // An unknown model gets the catalog's default window; read it back rather
  // than assume a number.
  const recorder = recorderFor(tasks, { workerModel: 'zen/test-model' }, clock)
  const usage = promptTokens => ({ promptTokens, completionTokens: 10, totalTokens: promptTokens + 10 })
  const llmEnd = (id, promptTokens) => ({ type: 'llm-end', agent: worker(id), round: 1, ms: 5, usage: usage(promptTokens) })
  drive(recorder, clock, [
    [1000, 'taskEvent', start('Task t1')],
    [1000, 'taskEvent', start('Task t2')],
    [1100, 'agentEvent', llmEnd('t1', 3000)],
    [1200, 'agentEvent', llmEnd('t1', 9000)],
    [1250, 'agentEvent', { type: 'warning', agent: worker('t1'), text: 'Context trimmed: 4 older message(s) dropped to fit the 8,000-token window' }],
    [1300, 'agentEvent', llmEnd('t1', 7000)],
    [1300, 'agentEvent', llmEnd('t2', 2000)],
    [1400, 'taskEvent', done('Task t1')],
    [1400, 'taskEvent', done('Task t2')],
  ])
  const result = recorder.result({ success: true })
  assert.deepEqual(result.tasks.map(t => [t.peakPromptTokens, t.contextTrims]), [[9000, 1], [2000, 0]])
  const share = result.tasks[0].peakContextShare
  assert.ok(share > 0 && share <= 1, `share ${share}`)
  assert.ok(result.tasks[1].peakContextShare < share)
  assert.equal(result.peakContextShare, share)
  assert.equal(result.contextTrims, 1)
})

// --- context management (K5) -------------------------------------------

/** The `pack` context event, as the Worker loop emits it. */
const packEvent = (id, over = {}) => ({
  type: 'context',
  agent: worker(id),
  kind: 'pack',
  pack: {
    tokens: 1200,
    hash: 'a'.repeat(64),
    paths: ['src/a.ts', 'src/deep/b.ts'],
    omitted: 2,
    stale: 1,
    relocated: 3,
    ...over,
  },
})

const contextEvent = (id, kind, detail) => ({ type: 'context', agent: worker(id), kind, detail })

/** A `read_file` call, which is what the seek ratio is mostly made of. */
const readStart = (id, path, callId = 'r1') => ({
  type: 'tool-start',
  agent: worker(id),
  callId,
  tool: 'read_file',
  summary: path,
})

const writeStart = (id, path, callId = 'w1') => ({
  type: 'tool-start',
  agent: worker(id),
  callId,
  tool: 'write_file',
  summary: path,
})

const searchStart = (id, query, callId = 's1') => ({
  type: 'tool-start',
  agent: worker(id),
  callId,
  tool: 'search_content',
  summary: `"${query}"`,
})

const listStart = (id, path, callId = 'l1') => ({
  type: 'tool-start',
  agent: worker(id),
  callId,
  tool: 'list_files',
  summary: path,
})

test('a pack is recorded whole: its size, its hash, what it cut and what it carried', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1', { writeFile: ['src/a.ts'] })], {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [1, 'agentEvent', packEvent('t1')],
    [2, 'agentEvent', done('Task t1')],
  ])

  const result = recorder.result({ success: true })
  const measured = result.tasks[0]
  assert.equal(measured.packTokens, 1200)
  assert.equal(measured.packHash, 'a'.repeat(64))
  assert.equal(measured.packSectionsCut, 2)
  assert.deepEqual(measured.packPaths, ['src/a.ts', 'src/deep/b.ts'])
  assert.equal(measured.staleAnchors, 1)
  assert.equal(measured.relocatedAnchors, 3)
  // And the run totals them, because a sweep compares runs and not tasks.
  assert.equal(result.packTokens, 1200)
  assert.equal(result.packSectionsCut, 2)
})

test('seek ratio is what the Worker looked for outside the pack, over every call', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1', { writeFile: ['src/a.ts'] })], {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [1, 'agentEvent', packEvent('t1')],
    [2, 'agentEvent', llmStart('t1')],
    // Covered by the pack: not a seek.
    [3, 'agentEvent', readStart('t1', 'src/a.ts')],
    // A directory holding something the pack carries is orienting, not seeking.
    [4, 'agentEvent', listStart('t1', 'src/deep')],
    [5, 'agentEvent', writeStart('t1', 'src/a.ts')],
    // Neither covered.
    [6, 'agentEvent', readStart('t1', 'src/elsewhere.ts')],
    [7, 'agentEvent', searchStart('t1', 'parse')],
    [8, 'agentEvent', done('Task t1')],
  ])

  const result = recorder.result({ success: true })
  const measured = result.tasks[0]
  assert.equal(measured.toolCalls, 5)
  assert.equal(measured.seeks, 2)
  assert.equal(measured.seekRatio, 0.4)
  assert.equal(result.seekRatio, 0.4)
})

test('the most-missed paths say what a pack should have carried', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1'), task('t2')], {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [1, 'agentEvent', readStart('t1', 'src/a.ts')],
    [2, 'agentEvent', readStart('t1', 'src/b.ts', 'r2')],
    [3, 'agentEvent', done('Task t1')],
    [4, 'taskEvent', start('Task t2')],
    [5, 'agentEvent', readStart('t2', 'src/b.ts')],
    [6, 'agentEvent', done('Task t2')],
  ])

  const result = recorder.result({ success: true })
  assert.deepEqual(result.mostMissedPaths, [
    { path: 'src/b.ts', count: 2 },
    { path: 'src/a.ts', count: 1 },
  ])
  // With no pack, every read is a seek: which is the point of turning the pack on.
  assert.equal(result.seekRatio, 1)
})

test('a read of a pack path before the Worker changed it is a read the pack did not save', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1', { writeFile: ['src/a.ts'] })], {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [1, 'agentEvent', packEvent('t1')],
    // Reading what the pack showed.
    [2, 'agentEvent', readStart('t1', 'src/a.ts', 'r1')],
    [3, 'agentEvent', readStart('t1', 'src/deep/b.ts', 'r2')],
    // Then changing one of them.
    [4, 'agentEvent', writeStart('t1', 'src/deep/b.ts')],
    // And reading it again, which is keeping its own copy honest.
    [5, 'agentEvent', readStart('t1', 'src/deep/b.ts', 'r3')],
    [6, 'agentEvent', done('Task t1')],
  ])

  const result = recorder.result({ success: true })
  assert.equal(result.tasks[0].redundantReads, 2)
  assert.equal(result.tasks[0].seeks, 0, 'all three reads were of paths the pack carried')
})

test('rounds to first edit is the round the first write was asked for in', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1', { writeFile: ['src/a.ts'] })], {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [1, 'agentEvent', llmStart('t1')],
    [2, 'agentEvent', llmStart('t1', 2)],
    [3, 'agentEvent', llmStart('t1', 3)],
    [4, 'agentEvent', writeStart('t1', 'src/a.ts')],
    [5, 'agentEvent', done('Task t1')],
  ])

  assert.equal(recorder.result({ success: true }).tasks[0].roundsToFirstEdit, 3)
})

test('a Worker that never wrote reports no rounds to a first edit, rather than zero', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1')], {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [1, 'agentEvent', llmStart('t1')],
    [2, 'agentEvent', done('Task t1')],
  ])

  assert.equal(recorder.result({ success: true }).tasks[0].roundsToFirstEdit, null)
})

test('elisions, compactions and stuck are counted per task and for the run', () => {
  const clock = fakeClock()
  const recorder = recorderFor([task('t1'), task('t2')], {}, clock)

  drive(recorder, clock, [
    [0, 'taskEvent', start('Task t1')],
    [1, 'agentEvent', contextEvent('t1', 'elided', '2 stale tool result(s) rewritten')],
    [2, 'agentEvent', contextEvent('t1', 'compacted', '1 file(s) changed; 300 token(s) kept')],
    [3, 'agentEvent', contextEvent('t1', 'elided', '1 stale tool result(s) rewritten')],
    [4, 'taskEvent', done('Task t1')],
    [5, 'taskEvent', start('Task t2')],
    [6, 'agentEvent', contextEvent('t2', 'stuck', 'its checkpoint alone needs 90000 tokens')],
    [7, 'taskEvent', done('Task t2')],
  ])

  const result = recorder.result({ success: true })
  assert.deepEqual(
    result.tasks.map(t => [t.elisions, t.compactions, t.stuck]),
    [
      [2, 1, 0],
      [0, 0, 1],
    ],
  )
  assert.equal(result.elisions, 2)
  assert.equal(result.compactions, 1)
  assert.equal(result.stuck, 1)
})

test('the slowest model round is kept per task, so a stalled request shows apart from a slow task', () => {
  const tasks = [task('t1', { writeFile: ['a.txt'] })]
  const clock = fakeClock()
  const recorder = recorderFor(tasks, {}, clock)
  const llmEnd = ms => ({ type: 'llm-end', agent: worker('t1'), round: 1, ms })
  drive(recorder, clock, [
    [1000, 'taskEvent', start('Task t1')],
    [1100, 'agentEvent', llmEnd(4000)],
    [1200, 'agentEvent', llmEnd(61000)],
    [1300, 'agentEvent', llmEnd(5000)],
    [1400, 'taskEvent', done('Task t1')],
  ])
  assert.equal(recorder.result({ success: true }).tasks[0].slowestRoundMs, 61000)
})
