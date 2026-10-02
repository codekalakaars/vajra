import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Imported before the code under test: the OpenAI SDK captures the global fetch
// when it loads, so the trampoline has to be in place first.
import { useProvider, sseResponse, roundChunks, toolFinish, textChunk, stopChunk } from './_provider.mjs'
import { useTempVajraHome } from './_isolate.mjs'

useTempVajraHome('vajra-run-')

/**
 * `vajra run` end to end: the Developer plans, the Manager runs the plan on
 * sandboxed Workers, and files change. The model is scripted; everything else,
 * including the forked worker process, is real.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const { runTask, RUN_EXIT_OK, RUN_EXIT_NO_PLAN, RUN_EXIT_SETUP } = await import(pathToFileURL(join(dist, 'cli', 'run.js')).href)

const CONFIG = fileURLToPath(new URL('../../../bench/config.json', import.meta.url))
const GOOD = 'export const hello = "world"\n'

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-run-project-'))
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const plan = {
  summary: 'add hello.js',
  tasks: [{
    id: 'hello',
    title: 'Create hello.js',
    description: 'a module that exports hello',
    type: 'create',
    dependsOn: [],
    edits: [{ op: 'create', path: 'hello.js', change: 'export const hello = "world"' }],
    verify: [{ command: 'node', args: ['--check', 'hello.js'], kind: 'proves-change' }],
  }],
}

/** Answers a Developer by script and a Worker by writing hello.js. */
function model(developerSteps) {
  let step = 0
  const asked = { developer: 0, worker: 0 }
  const restore = useProvider(async (_url, init) => {
    const messages = JSON.parse(init.body).messages
    const system = messages.find(m => m.role === 'system')?.content ?? ''
    if (system.startsWith('You are a worker agent')) {
      asked.worker++
      return sseResponse(roundChunks(
        messages.some(m => m.role === 'tool')
          ? { text: 'done' }
          : { toolCalls: [{ name: 'write_file', args: { path: 'hello.js', content: GOOD } }] },
      ))
    }
    asked.developer++
    const next = developerSteps[step++]
    if (next?.tool) {
      return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] },
        toolFinish,
      ])
    }
    return sseResponse([textChunk(next?.text ?? 'done'), stopChunk])
  })
  return { asked, restore }
}

const baseline = { tool: 'run_baseline', args: { command: 'node', args: ['--check', 'hello.js'] } }
const propose = { tool: 'propose_plan', args: plan }

async function run(dir, extra = {}) {
  const lines = []
  const saved = process.env.OPENCODE_API_KEY
  process.env.OPENCODE_API_KEY = 'sk-test'
  try {
    const code = await runTask({
      task: 'add a hello module',
      projectDir: dir,
      configPath: CONFIG,
      allowUnenforced: true,
      write: line => lines.push(line),
      writeText: () => {},
      ...extra,
    })
    return { code, text: lines.join('\n') }
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = saved
  }
}

test('the Developer plans, the plan is accepted, and the Workers write the file', async t => {
  const dir = project(t)
  const m = model([baseline, propose])
  t.after(() => m.restore())

  const { code, text } = await run(dir, { yes: true })

  assert.equal(code, RUN_EXIT_OK, text)
  assert.equal(readFileSync(join(dir, 'hello.js'), 'utf-8'), GOOD)
  assert.ok(m.asked.developer >= 2 && m.asked.worker >= 1, 'both roles were asked')
  assert.match(text, /Plan: 1 task/)
  assert.match(text, /done: Create hello\.js/)
})

test('a person who declines the plan stops the run before anything is written', async t => {
  const dir = project(t)
  const m = model([baseline, propose])
  t.after(() => m.restore())

  const { code, text } = await run(dir, { person: { answer: async () => null, review: async () => null } })

  assert.equal(code, RUN_EXIT_NO_PLAN)
  assert.equal(existsSync(join(dir, 'hello.js')), false)
  assert.equal(m.asked.worker, 0, 'no Worker was ever asked')
  assert.match(text, /Nothing was run/)
})

test('feedback on a plan goes back to the Developer, and the revised plan is the one that runs', async t => {
  const dir = project(t)
  const m = model([baseline, propose, propose])
  t.after(() => m.restore())
  const reviews = ['name the task better', true]

  const { code } = await run(dir, { person: { answer: async () => null, review: async () => reviews.shift() } })

  assert.equal(code, RUN_EXIT_OK)
  assert.equal(reviews.length, 0, 'both reviews happened')
  assert.equal(existsSync(join(dir, 'hello.js')), true)
})

test('setup problems exit 2 with the reason, before any model is asked', async t => {
  const dir = project(t)
  const m = model([])
  t.after(() => m.restore())

  const missingDir = await run(join(dir, 'nope'), { yes: true })
  assert.equal(missingDir.code, RUN_EXIT_SETUP)
  assert.match(missingDir.text, /project directory does not exist/)

  const badConfig = await run(dir, { yes: true, configPath: join(dir, 'missing.json') })
  assert.equal(badConfig.code, RUN_EXIT_SETUP)
  assert.equal(m.asked.developer, 0)
})

test('with --yes, a reply that is not a plan is nudged on rather than ending the run', async t => {
  const dir = project(t)
  const m = model([{ text: 'I have looked around.' }, baseline, propose])
  t.after(() => m.restore())

  const { code } = await run(dir, { yes: true })

  assert.equal(code, RUN_EXIT_OK)
  assert.equal(readFileSync(join(dir, 'hello.js'), 'utf-8'), GOOD)
})

test('with --yes, a Developer that never proposes a plan is stopped, not looped forever', async t => {
  const dir = project(t)
  const m = model(Array.from({ length: 40 }, () => ({ text: 'Still thinking.' })))
  t.after(() => m.restore())

  const { code, text } = await run(dir, { yes: true })

  assert.equal(code, RUN_EXIT_NO_PLAN)
  assert.match(text, /did not settle on a plan/)
  assert.equal(m.asked.worker, 0)
})
