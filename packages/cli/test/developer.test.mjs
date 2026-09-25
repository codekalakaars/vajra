import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * A turn spent entirely on tool calls used to print nothing at all. These drive
 * developerConversationTurn against a stubbed provider and assert the progress
 * events actually reach the caller — the mechanism existing is not evidence the
 * caller passes it (that is the 1C regression).
 */

const developerUrl = pathToFileURL(
  join(import.meta.dirname, '..', 'dist', 'agent', 'developer.js'),
).href

// The OpenAI SDK resolves the global fetch when it loads, so the stub has to be
// in place before developer.js is imported. `handler` is what a test swaps in.
let handler = null
globalThis.fetch = (...args) => handler(...args)

const { developerConversationTurn } = await import(developerUrl)

/**
 * One SSE event per chunk. Handing the SDK the whole body as a single string
 * makes its event decoder see one malformed frame — a fake that only works by
 * luck is worse than no fake.
 */
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
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const TOOL_CALL_CHUNK = name => ({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name, arguments: '{"path":"README.md"}' },
          },
        ],
      },
      finish_reason: null,
    },
  ],
})
const TOOL_FINISH = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
const TEXT_CHUNK = { choices: [{ delta: { content: 'done' }, finish_reason: null }] }
const STOP = { choices: [{ delta: {}, finish_reason: 'stop' }] }

/** Round 1 asks for a tool and says nothing; round 2 answers in prose. */
function stubProvider(toolName = 'read_file') {
  let round = 0
  handler = async () =>
    ++round === 1
      ? sseResponse([TOOL_CALL_CHUNK(toolName), TOOL_FINISH])
      : sseResponse([TEXT_CHUNK, STOP])
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-developer-'))
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  return dir
}

async function runTurn(overrides = {}) {
  const dir = makeProject()
  const events = []
  let prose = 0
  try {
    const result = await developerConversationTurn({
      sessionId: 's1',
      projectDir: dir,
      userMessage: 'do the thing',
      model: 'zen/test',
      apiKey: 'k',
      handle: { callTool: async () => '# demo\n' },
      messages: [],
      summaryIndex: [],
      onTextDelta: () => { prose++ },
      onAgentEvent: e => events.push(e),
      ...overrides,
    })
    return { result, events, prose }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a turn that only calls tools still reports progress, start to finish', async () => {
  stubProvider()
  const { result, events, prose } = await runTurn()

  assert.equal(result.type, 'response')
  // Exactly one delta, and it belongs to round 2: the tool round said nothing,
  // which is precisely the silence this feature exists to remove.
  assert.equal(prose, 1)

  assert.deepEqual(events.map(e => e.type), [
    'phase', // indexing: the first turn builds the project context
    'phase', // planning
    'llm-start',
    'llm-end',
    'tool-start',
    'tool-end',
    'llm-start',
    'llm-end',
  ])
})

test('every tool-start is closed by exactly one tool-end', async () => {
  stubProvider()
  const { events } = await runTurn()

  const starts = events.filter(e => e.type === 'tool-start')
  const ends = events.filter(e => e.type === 'tool-end')
  // A dangling start leaves a renderer showing that tool as outstanding forever.
  assert.equal(starts.length, 1)
  assert.equal(ends.length, 1)
  assert.equal(starts[0].callId, ends[0].callId)

  assert.equal(starts[0].agent.role, 'developer')
  assert.equal(starts[0].tool, 'read_file')
  assert.equal(starts[0].summary, 'README.md')
  assert.equal(ends[0].ok, true)
  assert.equal(typeof ends[0].ms, 'number')
})

test('rounds carry their number and the loop budget', async () => {
  stubProvider()
  const { events } = await runTurn()

  const starts = events.filter(e => e.type === 'llm-start')
  const ends = events.filter(e => e.type === 'llm-end')
  assert.deepEqual(starts.map(e => e.round), [1, 2])
  assert.deepEqual(ends.map(e => e.round), [1, 2])
  assert.ok(ends.every(e => typeof e.ms === 'number' && e.ms >= 0))
  assert.ok(ends.every(e => typeof e.budget === 'number' && e.budget > 0))
})

test('a tool the harness rejects is still reported as a completed event', async () => {
  stubProvider('definitely_not_a_tool')
  const { events } = await runTurn()

  const start = events.find(e => e.type === 'tool-start')
  const end = events.find(e => e.type === 'tool-end')
  assert.ok(start, 'the attempt must still be announced')
  assert.ok(end, 'and must still be finished')
  assert.equal(end.ok, false)
})

test('the event stream is observability only — the turn result is unchanged', async () => {
  stubProvider()
  const quiet = await runTurn({ onAgentEvent: () => {} })
  assert.equal(quiet.result.type, 'response')
  assert.equal(quiet.result.response, 'done')
})
