import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import {
  loadFixture,
  scriptedProvider,
  callShape,
  eventShape,
  recordingHandle,
  recordingUi,
} from './_provider.mjs'

/**
 * Replay: the Worker loop must produce the same observable behaviour for the
 * same provider script, every time.
 *
 * The counterpart to `replay-developer.test.mjs`, and it matters more, because
 * the two loops are the duplication the engine extraction is removing. They
 * batch read-only calls differently — the Developer pre-computes every read in a
 * message and replays the results, the Worker groups contiguous runs and awaits
 them in place — and that difference is load-bearing enough that unifying it
 * would be a behaviour change rather than a refactor. Pinning both makes the
 * difference something a refactor has to preserve rather than something it can
 * quietly normalise away.
 */

const executeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tasks', 'execute.js')).href
const paramsUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'bench', 'params.js')).href
const { executeTask } = await import(executeUrl)
const { TODAYS_PARAMS } = await import(paramsUrl)

const fixture = loadFixture('worker-basic')

function makeProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-replay-worker-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return dir
}

/** One replayed task run. Returns everything the fixture pins. */
async function replayTask() {
  const provider = scriptedProvider(fixture.rounds)
  const projectDir = makeProject(fixture.project.files)
  const handle = recordingHandle(fixture.answers)
  const ui = recordingUi()
  const events = []
  try {
    const ok = await executeTask(
      'agent-replay',
      fixture.task,
      handle,
      'sk-replay',
      'zen/replay-model',
      ui,
      null, // changeHistory — the loop does not use it
      null, // queue
      null, // registry
      'session-replay',
      null, // fileLocks — no validation server in this fixture
      projectDir,
      undefined,
      event => events.push(event),
      // The knobs as they stand: the fixture pins today's behaviour, so the
      // replay is what proves threading them through changed nothing.
      TODAYS_PARAMS,
    )
    return { ok, events, calls: handle.calls, ui }
  } finally {
    provider.restore()
    rmSync(projectDir, { recursive: true, force: true })
  }
}

test('a replayed Worker task dispatches the same tool calls, in order', async () => {
  const { calls } = await replayTask()
  assert.deepEqual(callShape(calls), fixture.expect.calls)
})

test('a replayed Worker task emits the same event stream', async () => {
  const { events } = await replayTask()
  assert.deepEqual(
    events.map(event => event.type),
    fixture.expect.eventTypes,
  )
})

test('validation is reported under its own callId, not the model round', async () => {
  const { events } = await replayTask()
  const validation = eventShape(events).filter(event => event.callId?.startsWith('validate-'))
  assert.deepEqual(
    validation.map(event => [event.type, event.callId, event.ok]),
    [
      ['tool-start', 'validate-node --test', undefined],
      ['tool-end', 'validate-node --test', true],
    ],
  )
})

test('a replayed Worker task returns the same value', async () => {
  const { ok, ui } = await replayTask()
  assert.equal(ok, fixture.expect.returns)
  // The loop leaves on an empty round, and says so through finishLine. A
  // regression here loses the buffered answer the TUI is holding.
  const finishLines = ui.calls.filter(call => call[0] === 'finishLine')
  assert.equal(finishLines.length, fixture.expect.finishLineCalls)
})

test('replaying twice produces identical output', async () => {
  const first = await replayTask()
  const second = await replayTask()
  assert.deepEqual(eventShape(second.events), eventShape(first.events))
  assert.deepEqual(callShape(second.calls), callShape(first.calls))
  assert.equal(second.ok, first.ok)
})
