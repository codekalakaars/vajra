import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isolateEachTest } from './_isolate.mjs'

// A key written by one test must not answer the next one's "is there a key".
isolateEachTest('vajra-apikey-')

const distUrl = (...parts) =>
  pathToFileURL(join(import.meta.dirname, '..', 'dist', ...parts)).href

const { SessionStore } = await import(distUrl('tui', 'session', 'store.js'))
const { askForTask } = await import(distUrl('tui', 'session', 'idle-prompt.js'))
const { writeAuth } = await import(distUrl('auth.js'))

// The gate resolves through env first, so a key in this process would answer
// every "is there a key" question the tests are asking on purpose.
delete process.env.OPENCODE_API_KEY

/**
 * The credential gate: no key, and the screen says so instead of running a
 * session that cannot reach the gateway.
 *
 * The bug this exists for was a shell loop, not a message: a bail inside
 * runSession returned instantly, the loop started the next one immediately,
 * and a machine with no key republished the whole snapshot until the heap
 * died. So the assertions are about the prompt and about the gate blocking —
 * it must never resolve without the user, and it must not return a task that
 * was typed while there was no key behind it.
 */

const MODEL = 'zen/space-bunny-free'

/** Let the gate's loop run to its next prompt. */
const settle = () => new Promise(resolve => setImmediate(resolve))

/** Wait for the store to reach `predicate`, so a test asserts on a state. */
async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the store')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * Drive one gate: open it, then answer its prompts the way a keystroke would.
 * `answer` leaves the gate waiting (that is the point of it); `settle` waits
 * for the outcome.
 */
async function openGate(store, { key, stopping = () => false, asked = false } = {}) {
  if (key) writeAuth({ OPENCODE_API_KEY: key })
  const pending = askForTask({
    store,
    model: MODEL,
    asked,
    stopping,
    // The app polls once a second; a test should not have to.
    pollMs: 10,
  })
  await settle()
  return {
    pending,
    /**
     * Configure a key the way the user would from another terminal, so the
     * gate finds it through the real resolution path on its next poll.
     */
    setKey(next) {
      writeAuth({ OPENCODE_API_KEY: next })
    },
    answer(value) {
      store.submitPrompt(value)
    },
    async settle(value) {
      store.submitPrompt(value)
      return pending
    },
    prompt: () => store.getSnapshot().prompt,
    entries: () => store.getSnapshot().entries,
  }
}

const texts = entries => entries.map(entry => entry.text)

test('with no key the screen asks for one, and says how to set it', async () => {
  const store = new SessionStore()
  const gate = await openGate(store)

  assert.equal(gate.prompt().kind, 'no-key')
  assert.match(gate.prompt().label, /API key/i)
  const notice = texts(gate.entries())
  assert.ok(
    notice.some(line => /vajra auth login/.test(line)),
    `expected the login command in the notice, got ${JSON.stringify(notice)}`,
  )
  assert.ok(
    notice.some(line => /OPENCODE_API_KEY/.test(line)),
    `expected the env var in the notice, got ${JSON.stringify(notice)}`,
  )
})

test('the notice is said once, however many times Enter is pressed', async () => {
  const store = new SessionStore()
  const gate = await openGate(store)
  gate.answer('')
  await settle()
  assert.equal(gate.prompt().kind, 'no-key')
  gate.answer('')
  await settle()
  assert.equal(gate.prompt().kind, 'no-key')

  const notices = texts(gate.entries()).filter(line => /OPENCODE_API_KEY/.test(line))
  assert.equal(notices.length, 1, `expected one notice, got ${notices.length}`)
})

test('a task typed with no key is held, and runs when a key appears', async () => {
  const store = new SessionStore()
  const gate = await openGate(store)

  gate.answer('fix the login bug')
  await settle()
  assert.equal(
    gate.prompt().kind,
    'no-key',
    'the gate stays up: the task cannot run without a key',
  )
  assert.ok(
    texts(gate.entries()).some(line => /fix the login bug/.test(line) && /held/i.test(line)),
    'the transcript says the task is held, not lost',
  )

  // A key written from outside is picked up on the next poll — no keypress.
  gate.setKey('sk-test-key')
  const outcome = await gate.pending
  assert.equal(outcome.kind, 'task')
  assert.equal(outcome.task, 'fix the login bug')
  assert.equal(outcome.key, 'sk-test-key')
})

test('a key with nothing typed reopens the idle prompt', async () => {
  const store = new SessionStore()
  const gate = await openGate(store)

  gate.setKey('sk-test-key')
  await until(() => gate.prompt()?.kind === 'initial-first')
  const outcome = await gate.settle('now what can you do')
  assert.equal(outcome.kind, 'task')
  assert.equal(outcome.task, 'now what can you do')
})

test('exit at the gate leaves instead of starting a run', async () => {
  const store = new SessionStore()
  const gate = await openGate(store)
  const outcome = await gate.settle('exit')
  assert.equal(outcome.kind, 'exit')
})

test('the second idle prompt is the re-entry one', async () => {
  const store = new SessionStore()
  const first = await openGate(store, { key: 'sk-test-key' })
  assert.equal(first.prompt().kind, 'initial-first')
  assert.equal((await first.settle('first task')).task, 'first task')

  const second = await openGate(store, { key: 'sk-test-key', asked: true })
  assert.equal(second.prompt().kind, 'initial-reentry')
})

test('a shell that is shutting down does not wait on the gate', async () => {
  const store = new SessionStore()
  let stopping = false
  const gate = await openGate(store, { stopping: () => stopping })
  assert.equal(gate.prompt().kind, 'no-key')
  stopping = true
  const outcome = await gate.settle('')
  assert.equal(outcome.kind, 'quit')
})

test('an explicit --api-key is the key, with no gate at all', async () => {
  const store = new SessionStore()
  const pending = askForTask({
    store,
    model: MODEL,
    explicitKey: 'sk-from-flag',
    asked: false,
    stopping: () => false,
  })
  await settle()
  assert.equal(store.getSnapshot().prompt.kind, 'initial-first')
  store.submitPrompt('do the thing')
  const outcome = await pending
  assert.equal(outcome.kind, 'task')
  assert.equal(outcome.key, 'sk-from-flag')
})
