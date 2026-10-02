import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// Imported before the code under test: the OpenAI SDK captures the global fetch
// when it loads, so the trampoline has to be in place first.
import { useProvider, sseResponse, toolFinish, textChunk, stopChunk } from './_provider.mjs'

/**
 * planWithDeveloper: the loop that turns the Developer's replies into a question
 * for a person or an accepted plan. The Developer's own behaviour has its tests;
 * what is checked here is the conversation around it.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const { planWithDeveloper } = await import(pathToFileURL(join(dist, 'developer', 'conversation.js')).href)

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-conversation-'))
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const handle = {
  callTool: async tool =>
    tool === 'run_baseline' ? JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: '' }) : '# demo\n',
}

const task = id => ({
  id,
  title: `Task ${id}`,
  description: 'why it matters',
  type: 'modify',
  dependsOn: [],
  context: [{ path: 'README.md', reason: 'the heading this changes' }],
  edits: [{ op: 'modify', path: 'README.md', anchor: '# demo', change: 'name the project' }],
  verify: [{ command: 'node', args: ['--check', 'README.md'], kind: 'proves-change' }],
})

const read = { tool: { name: 'read_file', args: { path: 'README.md' } } }
const baseline = { tool: { name: 'run_baseline', args: { command: 'node', args: ['--check', 'README.md'] } } }
const propose = id => ({ tool: { name: 'propose_plan', args: { summary: 's', tasks: [task(id)] } } })
const say = text => ({ text })

/** A model that follows `steps` one round at a time, then falls silent. */
function model(steps) {
  const requests = []
  let n = 0
  const restore = useProvider(async (_url, init) => {
    requests.push(JSON.parse(init.body))
    const step = steps[n++]
    if (step?.tool) {
      return sseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) },
              }],
            },
            finish_reason: null,
          }],
        },
        toolFinish,
      ])
    }
    return sseResponse([textChunk(step?.text ?? 'done'), stopChunk])
  })
  return { requests, restore }
}

/** A person who answers from lists, and records what they were shown. */
function person({ answers = [], reviews = [] } = {}) {
  const shown = { answers: [], plans: [] }
  return {
    shown,
    answer: async response => {
      shown.answers.push(response)
      return answers.length ? answers.shift() : null
    },
    review: async plan => {
      shown.plans.push(plan)
      return reviews.length ? reviews.shift() : null
    },
  }
}

const run = (dir, p, extra = {}) =>
  planWithDeveloper({ projectDir: dir, apiKey: 'k', model: 'zen/test', task: 'rename the project', handle, person: p, ...extra })

test('a plan the person accepts is returned', async t => {
  const dir = project(t)
  const m = model([read, baseline, propose('first')])
  t.after(() => m.restore())
  const p = person({ reviews: [true] })

  const outcome = await run(dir, p)

  assert.equal(outcome.type, 'plan')
  assert.equal(outcome.plan.tasks[0].id, 'first')
  assert.equal(p.shown.plans.length, 1)
  assert.match(JSON.stringify(m.requests[0].messages), /rename the project/, 'the Developer was given the task')
})

test('a question is put to the person, and their answer goes back to the Developer', async t => {
  const dir = project(t)
  const m = model([say('Which file should the heading change in?'), read, baseline, propose('after-answer')])
  t.after(() => m.restore())
  const p = person({ answers: ['README.md please'], reviews: [true] })

  const outcome = await run(dir, p)

  assert.deepEqual(p.shown.answers, ['Which file should the heading change in?'])
  assert.equal(outcome.type, 'plan')
  const lastRequest = JSON.stringify(m.requests.at(-1).messages)
  assert.match(lastRequest, /README\.md please/, 'the answer reached the model')
})

test('a rejected plan comes back as feedback, and the next plan can be accepted without re-reading', async t => {
  const dir = project(t)
  const m = model([read, baseline, propose('first'), propose('second')])
  t.after(() => m.restore())
  const p = person({ reviews: ['make it smaller', true] })

  const outcome = await run(dir, p)

  assert.equal(p.shown.plans.length, 2)
  assert.equal(outcome.type, 'plan')
  assert.equal(outcome.plan.tasks[0].id, 'second')
  assert.match(JSON.stringify(m.requests.at(-1).messages), /make it smaller/, 'the feedback reached the model')
  const reads = m.requests.at(-1).messages.filter(msg => msg.role === 'assistant' && msg.tool_calls).flatMap(msg => msg.tool_calls).filter(c => c.function.name === 'read_file')
  assert.equal(reads.length, 1, 'the evidence from the first turn was kept')
})

test('the person can stop at a question or at a plan', async t => {
  const dir = project(t)
  let m = model([say('Anything else I should know?')])
  t.after(() => m.restore())
  assert.deepEqual(await run(dir, person()), { type: 'stopped', reason: 'person' })
  m.restore()

  m = model([read, baseline, propose('first')])
  assert.deepEqual(await run(dir, person({ reviews: [null] })), { type: 'stopped', reason: 'person' })
  m.restore()
})

test('a Developer that never settles is stopped after maxTurns', async t => {
  const dir = project(t)
  const m = model(Array.from({ length: 10 }, () => say('Hmm, tell me more?')))
  t.after(() => m.restore())
  const p = person({ answers: ['more', 'more', 'more', 'more', 'more'] })

  const outcome = await run(dir, p, { maxTurns: 3 })

  assert.deepEqual(outcome, { type: 'stopped', reason: 'turns' })
  assert.equal(p.shown.answers.length, 3)
})

test('an interrupt before the next turn stops the conversation', async t => {
  const dir = project(t)
  const m = model([say('question one')])
  t.after(() => m.restore())
  const controller = new AbortController()
  const p = person({ answers: ['go on'] })
  const origAnswer = p.answer
  p.answer = async response => {
    const out = await origAnswer(response)
    controller.abort()
    return out
  }

  const outcome = await run(dir, p, { signal: controller.signal })

  assert.deepEqual(outcome, { type: 'stopped', reason: 'interrupted' })
})
