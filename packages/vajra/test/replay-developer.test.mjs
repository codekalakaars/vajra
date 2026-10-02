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
  useProvider,
} from './_provider.mjs'

/**
 * Replay: the Developer loop must produce the same observable behaviour for the
 * same provider script, every time.
 *
 * This is the safety net for any change to the model/tool loop in
 * `developer.ts` and `execute.ts`: a refactor that cannot be proven identical
 * is a guess. What is pinned here is the part a
 * refactor could plausibly break and a unit test would not notice: the order
 * tool calls are dispatched in, the order their results are appended to the
 * conversation, the event stream the UI receives, and the value the turn
 * returns.
 *
 * The provider script is a fixture, so the model side is fixed and the loop is
 * the only variable.
 */

const developerUrl = pathToFileURL(
  join(import.meta.dirname, '..', 'dist', 'developer', 'developer.js'),
).href

// The stub has to be in place before the module under test loads: the OpenAI SDK
// captures the global fetch when it is imported.
useProvider(() => {
  throw new Error('no provider installed for this test')
})

const { developerConversationTurn, createEvidenceLedger } = await import(developerUrl)

const fixture = loadFixture('developer-basic')

function makeProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-replay-dev-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return dir
}
/** One replayed turn. Returns everything the fixture pins. */
async function replayTurn() {
  const provider = scriptedProvider(fixture.rounds)
  const projectDir = makeProject(fixture.project.files)
  const handle = recordingHandle(fixture.answers)
  const events = []
  try {
    const result = await developerConversationTurn({
      sessionId: 'replay-session',
      projectDir,
      userMessage: 'make the suite pass',
      model: 'zen/replay-model',
      apiKey: 'sk-replay',
      handle,
      messages: [],
      summaryIndex: [],
      evidence: createEvidenceLedger(),
      onTextDelta: () => {},
      onAgentEvent: event => events.push(event),
    })
    return { result, events, calls: handle.calls, messages: result.messages }
  } finally {
    provider.restore()
    rmSync(projectDir, { recursive: true, force: true })
  }
}

test('a replayed Developer turn dispatches the same tool calls, in order', async () => {
  const { calls } = await replayTurn()
  assert.deepEqual(callShape(calls), fixture.expect.calls)
})

test('a replayed Developer turn emits the same event stream', async () => {
  const { events } = await replayTurn()
  assert.deepEqual(
    events.map(event => event.type),
    fixture.expect.eventTypes,
  )
})

test('every tool call is reported start-then-end, in dispatch order', async () => {
  const { events } = await replayTurn()
  // The transcript is built from these two events, so a swapped order or a
  // mismatched callId corrupts what the user reads without failing any count.
  const toolEvents = eventShape(events).filter(
    event => event.type === 'tool-start' || event.type === 'tool-end',
  )
  assert.deepEqual(
    toolEvents.map(event => [event.type, event.tool, event.agent.role]),
    [
      // The two reads are one batch: both start, then both end, in model order.
      ['tool-start', 'read_file', 'developer'],
      ['tool-start', 'read_file', 'developer'],
      ['tool-end', 'read_file', 'developer'],
      ['tool-end', 'read_file', 'developer'],
      // run_baseline is not read-only, so it takes the single-call path.
      ['tool-start', 'run_baseline', 'developer'],
      ['tool-end', 'run_baseline', 'developer'],
    ],
  )
  // The invariant the TUI actually depends on: a started call is ended exactly
  // once. A dangling start leaves a spinner that never resolves.
  const starts = toolEvents.filter(event => event.type === 'tool-start').map(event => event.callId)
  const ends = toolEvents.filter(event => event.type === 'tool-end').map(event => event.callId)
  assert.equal(starts.length, 3)
  assert.deepEqual([...ends].sort(), [...starts].sort())
})

test('a replayed Developer turn returns the same result', async () => {
  const { result } = await replayTurn()
  assert.equal(result.type, fixture.expect.resultType)
  assert.equal(result.response, fixture.expect.response)
})

test('replaying twice produces identical output', async () => {
  const first = await replayTurn()
  const second = await replayTurn()
  assert.deepEqual(eventShape(second.events), eventShape(first.events))
  assert.deepEqual(callShape(second.calls), callShape(first.calls))
  assert.deepEqual(second.result, first.result)
})
