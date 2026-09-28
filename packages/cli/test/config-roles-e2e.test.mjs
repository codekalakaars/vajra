import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { isolateEachTest } from './_isolate.mjs'

/**
 * The role models, as the session actually uses them.
 *
 * The pure resolution is tested in config-roles.test.mjs. What is tested here is
 * the part that can only be wrong in a way nobody would notice by reading the
 * code: whether the developer's model reaches the provider, and whether the
 * record of the session says which models ran. A role model that resolves
 * correctly and then gets ignored is a setting that lies.
 */

isolateEachTest('vajra-roles-e2e-')

// The SDK resolves the global fetch when it loads, so the stub has to be in
// place before anything that imports it.
let handler = null
globalThis.fetch = (...args) => handler(...args)

const dist = join(import.meta.dirname, '..', 'dist')
const { runSession } = await import(pathToFileURL(join(dist, 'session', 'service.js')).href)
const { loadSession, listSessions } = await import(
  pathToFileURL(join(dist, 'persist', 'index.js')).href
)

/** One SSE event per chunk, so the SDK's decoder sees real frames. */
function sseResponse(payloads) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const makeUI = (answers = []) => {
  const calls = []
  const next = kind => {
    const answer = answers.shift()
    if (answer === undefined) throw new Error(`unexpected prompt: ${kind}`)
    return answer
  }
  return {
    calls,
    banner: () => {},
    info: m => calls.push(['info', m]),
    success: () => {},
    error: m => calls.push(['error', m]),
    warning: m => calls.push(['warning', m]),
    newline: () => {},
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    finishLine: () => {},
    discardBuffer: () => {},
    askInitialTask: kind => Promise.resolve(next(`initial:${kind}`)),
    askUserMessage: () => Promise.resolve(next('user')),
    showPlan: () => {},
    askConfirmPlan: () => Promise.resolve(next('confirm')),
    askRejectFeedback: () => Promise.resolve(next('feedback')),
    onTaskEvent: () => {},
    text: () => calls.map(c => c[1] ?? '').join('\n'),
  }
}

test("the developer's model is what the provider is asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-role-e2e-'))
  const asked = []
  handler = async (_url, init) => {
    asked.push(JSON.parse(init.body))
    // A turn that answers in prose and stops, so the session unwinds and the
    // test does not need a plan, a confirmation and a task.
    return sseResponse([
      { choices: [{ delta: { content: 'Noted.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
  }
  try {
    const ui = makeUI(['exit'])
    await runSession(
      {
        model: 'zen/default-model',
        developerModel: 'zen/developer-model',
        workerModel: 'zen/worker-model',
        apiKey: 'sk-test',
        projectDir: dir,
        task: 'hello',
      },
      ui,
    )
    assert.ok(asked.length > 0, 'the developer turn must have reached the provider')
    for (const body of asked) {
      assert.equal(body.model, 'developer-model', `expected the developer's model, got ${body.model}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session with no role models asks the default, as it always did', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-role-e2e-default-'))
  const asked = []
  handler = async (_url, init) => {
    asked.push(JSON.parse(init.body))
    return sseResponse([
      { choices: [{ delta: { content: 'Noted.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
  }
  try {
    const ui = makeUI(['exit'])
    await runSession({ model: 'zen/default-model', apiKey: 'sk-test', projectDir: dir, task: 'hi' }, ui)
    assert.ok(asked.length > 0)
    for (const body of asked) assert.equal(body.model, 'default-model')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the record says which models ran, so a resume does not misdescribe it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-role-e2e-record-'))
  handler = async () =>
    sseResponse([
      { choices: [{ delta: { content: 'Noted.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
  try {
    const ui = makeUI(['exit'])
    await runSession(
      {
        model: 'zen/default-model',
        developerModel: 'zen/developer-model',
        managerModel: 'zen/manager-model',
        workerModel: 'zen/worker-model',
        apiKey: 'sk-test',
        projectDir: dir,
        task: 'hi',
      },
      ui,
    )
    const [summary] = listSessions(dir)
    assert.ok(summary, 'the session must have been recorded')
    const stored = loadSession(summary.sessionId, dir)
    assert.equal(stored.config.model, 'zen/default-model')
    assert.equal(stored.config.developerModel, 'zen/developer-model')
    assert.equal(stored.config.managerModel, 'zen/manager-model')
    assert.equal(stored.config.workerModel, 'zen/worker-model')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record from a session that used the default says nothing extra', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-role-e2e-clean-'))
  handler = async () =>
    sseResponse([
      { choices: [{ delta: { content: 'Noted.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
  try {
    const ui = makeUI(['exit'])
    await runSession({ model: 'zen/only-model', apiKey: 'sk-test', projectDir: dir, task: 'hi' }, ui)
    const [summary] = listSessions(dir)
    const stored = loadSession(summary.sessionId, dir)
    // Three keys that all say the same thing is noise in a file a human reads.
    assert.equal('developerModel' in stored.config, false)
    assert.equal('managerModel' in stored.config, false)
    assert.equal('workerModel' in stored.config, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a role model this build cannot run is refused before any work starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-role-e2e-bad-'))
  let asked = 0
  handler = async () => {
    asked += 1
    return sseResponse([])
  }
  try {
    const ui = makeUI([])
    const result = await runSession(
      {
        model: 'zen/default-model',
        workerModel: 'openai/gpt-4o',
        apiKey: 'sk-test',
        projectDir: dir,
        task: 'hi',
      },
      ui,
    )
    assert.equal(result.exitCode, 1)
    // The role is named, because "unsupported model" without it would send the
    // user looking at the wrong line of their config.
    assert.match(ui.text(), /Unsupported worker model 'openai\/gpt-4o'/)
    assert.equal(asked, 0, 'nothing may be sent to a provider for a session that cannot run')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
