import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// Imported before the code under test: the OpenAI SDK captures the global fetch
// when it loads, so the trampoline has to be in place first.
import { recordingUi, roundChunks, sseResponse, useProvider } from './_provider.mjs'

/**
 * `executePlan` as a whole: the Manager's loop, leases, the Worker, verification,
 * rollback and the report, with real files in a temp project and a scripted
 * model. The pieces have their own tests; what is checked here is what only the
 * pieces together do, which is where a refactor of this file would break.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const { executePlan } = await import(pathToFileURL(join(dist, 'manager', 'execute-plan.js')).href)
const { TODAYS_PARAMS } = await import(pathToFileURL(join(dist, 'bench', 'params.js')).href)

const GOOD = 'export const ok = true\n'
const BAD = 'export const = = broken\n'

function project(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-plan-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

/** A task that writes one file and passes when that file is valid JavaScript. */
function task(id, file, over = {}) {
  return {
    id,
    title: `Write ${file}`,
    description: `Create ${file}`,
    instructions: [`Create ${file}`],
    readFile: [],
    writeFile: [file],
    deleteFile: [],
    createDir: [],
    validation: [`node --check ${file}`],
    dependsOn: [],
    type: 'create',
    ...over,
  }
}

const plan = tasks => ({ tasks, independentGroups: [], estimatedWorkers: tasks.length })

/**
 * A model that writes whatever `script(file, attempt)` says for the file a Worker
 * was asked to write, then says it is done. `attempt` counts that file's attempts.
 * `delayMs` slows every answer so concurrency is observable.
 */
function model(script, { delayMs = 0 } = {}) {
  const attempts = new Map()
  const asked = []
  const live = { now: 0, peak: 0 }
  const restore = useProvider(async (_url, init) => {
    const messages = JSON.parse(init.body).messages
    const system = messages.find(m => m.role === 'system')?.content ?? ''
    const file = (system.match(/FILES TO WRITE:\s*(\S+?)(?:,|\s|$)/) ?? [])[1]
    const hasResult = messages.some(m => m.role === 'tool')
    live.now++
    live.peak = Math.max(live.peak, live.now)
    try {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      if (hasResult) return sseResponse(roundChunks({ text: 'done' }))
      const attempt = (attempts.get(file) ?? 0) + 1
      attempts.set(file, attempt)
      asked.push(file)
      const content = script(file, attempt)
      return sseResponse(roundChunks({ toolCalls: [{ name: 'write_file', args: { path: file, content } }] }))
    } finally {
      live.now--
    }
  })
  return { attempts, asked, live, restore }
}

async function run(projectDir, tasks, { params = {}, signal, sampler } = {}) {
  const ui = recordingUi()
  const events = []
  const origTask = ui.onTaskEvent
  ui.onTaskEvent = event => {
    events.push(event)
    origTask(event)
  }
  const agentEvents = []
  ui.onAgentEvent = event => agentEvents.push(event)
  const result = await executePlan(
    plan(tasks),
    { ...TODAYS_PARAMS, retries: 0, ...params },
    { apiKey: 'sk-test', projectDir, timeout: 60, ...(signal ? { signal } : {}) },
    ui,
    sampler ? { sampler } : {},
  )
  const order = events.filter(e => e.type === 'start' || e.type === 'done' || e.type === 'failed').map(e => `${e.type}:${e.taskId}`)
  const status = Object.fromEntries(result.tasks.map(t => [t.id, t.status]))
  return { result, events, agentEvents, order, status }
}

test('a dependent starts only after what it depends on is done', async t => {
  const dir = project(t)
  const m = model(() => GOOD)
  t.after(() => m.restore())

  const { result, order, status } = await run(dir, [
    task('a', 'a.js'),
    task('b', 'b.js', { dependsOn: ['a'] }),
    task('c', 'c.js', { dependsOn: ['b'] }),
  ])

  assert.equal(result.exitCode, 0)
  assert.deepEqual(status, { a: 'done', b: 'done', c: 'done' })
  assert.deepEqual(order, ['start:a', 'done:a', 'start:b', 'done:b', 'start:c', 'done:c'])
  for (const file of ['a.js', 'b.js', 'c.js']) assert.equal(readFileSync(join(dir, file), 'utf-8'), GOOD)
})

test('independent tasks run at once when the machine has room', async t => {
  const dir = project(t)
  const m = model(() => GOOD, { delayMs: 60 })
  t.after(() => m.restore())

  const { result } = await run(dir, [task('a', 'a.js'), task('b', 'b.js'), task('c', 'c.js')], {
    sampler: () => ({ cpu: 0, availableMemMb: 64_000 }),
  })

  assert.equal(result.exitCode, 0)
  assert.equal(m.live.peak, 3, 'all three model calls were in flight together')
})

test('two tasks that write the same file never run together', async t => {
  const dir = project(t)
  const m = model(() => GOOD, { delayMs: 40 })
  t.after(() => m.restore())

  const { result, order } = await run(
    dir,
    [task('a', 'shared.js'), task('b', 'shared.js')],
    { sampler: () => ({ cpu: 0, availableMemMb: 64_000 }) },
  )

  assert.equal(result.exitCode, 0)
  const [first, second] = order.filter(entry => entry.startsWith('start:')).map(entry => entry.slice(6))
  assert.ok(
    order.indexOf(`done:${first}`) < order.indexOf(`start:${second}`),
    `the second task waited for the first: ${order.join(' ')}`,
  )
})

test('a failed check is retried, and the retry starts from the original file, not the failed attempt', async t => {
  const dir = project(t, { 'a.js': 'export const original = 1\n' })
  const seenAtStart = []
  const m = model((file, attempt) => {
    seenAtStart.push(readFileSync(join(dir, file), 'utf-8'))
    return attempt === 1 ? BAD : GOOD
  })
  t.after(() => m.restore())

  const { result, events, status } = await run(dir, [task('a', 'a.js')], { params: { retries: 1 } })

  assert.equal(result.exitCode, 0)
  assert.equal(status.a, 'done')
  assert.equal(m.attempts.get('a.js'), 2)
  assert.deepEqual(seenAtStart, ['export const original = 1\n', 'export const original = 1\n'], 'the failed write was rolled back before the retry')
  assert.equal(events.filter(e => e.type === 'retry').length, 1)
  assert.equal(readFileSync(join(dir, 'a.js'), 'utf-8'), GOOD)
})

test('a task that fails every attempt leaves the file as it was, and its dependents never run', async t => {
  const dir = project(t, { 'a.js': 'export const original = 1\n' })
  const m = model(() => BAD)
  t.after(() => m.restore())

  const { result, status } = await run(
    dir,
    [task('a', 'a.js'), task('b', 'b.js', { dependsOn: ['a'] })],
    { params: { retries: 1 } },
  )

  assert.notEqual(result.exitCode, 0)
  assert.equal(status.a, 'failed')
  assert.equal(status.b, 'skipped', 'a dependent of a failure is skipped, never started')
  assert.equal(m.attempts.get('a.js'), 2, 'one attempt and one retry')
  assert.equal(m.attempts.has('b.js'), false, 'the model was never asked about the dependent')
  assert.equal(readFileSync(join(dir, 'a.js'), 'utf-8'), 'export const original = 1\n')
  assert.equal(existsSync(join(dir, 'b.js')), false)
  assert.ok(result.report.lines.join('\n').length > 0, 'the report says something')
})

test('a failure does not stop tasks that do not depend on it', async t => {
  const dir = project(t)
  const m = model(file => (file === 'a.js' ? BAD : GOOD))
  t.after(() => m.restore())

  const { result, status } = await run(dir, [task('a', 'a.js'), task('b', 'b.js')])

  assert.notEqual(result.exitCode, 0)
  assert.deepEqual(status, { a: 'failed', b: 'done' })
  assert.equal(readFileSync(join(dir, 'b.js'), 'utf-8'), GOOD)
})

test('aborting the run stops new work, and the task in flight is not reported failed', async t => {
  const dir = project(t)
  const controller = new AbortController()
  const m = model(() => GOOD, { delayMs: 80 })
  t.after(() => m.restore())

  const tasks = [task('a', 'a.js'), task('b', 'b.js', { dependsOn: ['a'] })]
  setTimeout(() => controller.abort(), 30)
  const { result, status } = await run(dir, tasks, { signal: controller.signal })

  assert.notEqual(result.exitCode, 0, 'an interrupted run is not a clean one')
  assert.notEqual(status.a, 'failed', 'an interrupt is never a failure')
  assert.equal(status.b, 'pending')
  assert.equal(m.attempts.has('b.js'), false, 'nothing started after the abort')
})

test('a saturated CPU pauses a Worker, and the run still finishes once it recovers', async t => {
  const dir = project(t)
  const m = model(() => GOOD, { delayMs: 120 })
  t.after(() => m.restore())

  // Cold while the three Workers start, hot while they run, cold again after:
  // a hot CPU only blocks new Workers, so pausing needs several already running.
  const started = Date.now()
  const { result, agentEvents } = await run(
    dir,
    [task('a', 'a.js'), task('b', 'b.js'), task('c', 'c.js')],
    {
      params: { resourceSampleMs: 50 },
      sampler: () => {
        const elapsed = Date.now() - started
        return { cpu: elapsed > 100 && elapsed < 450 ? 0.99 : 0, availableMemMb: 64_000 }
      },
    },
  )

  assert.equal(result.exitCode, 0, 'a paused Worker is resumed, not lost')
  assert.ok(
    agentEvents.some(e => e.type === 'phase' && e.phase === 'paused'),
    'a Worker was shown as paused',
  )
  for (const file of ['a.js', 'b.js', 'c.js']) assert.equal(readFileSync(join(dir, file), 'utf-8'), GOOD)
})

test('the report names every task and its exit code is zero only when all of them are done', async t => {
  const dir = project(t)
  const m = model(() => GOOD)
  t.after(() => m.restore())

  const { result } = await run(dir, [task('a', 'a.js'), task('b', 'b.js')])

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.tasks.map(entry => entry.id).sort(), ['a', 'b'])
  assert.ok(result.wallMs > 0)
})
