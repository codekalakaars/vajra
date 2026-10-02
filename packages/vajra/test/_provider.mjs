import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * One provider double for the whole suite, and the recorder that produces the
 * replay fixtures.
 *
 * There were two hand-rolled `globalThis.fetch` stubs with different chunk
 * vocabularies (`developer.test.mjs` and `parallel-tools.test.mjs`). Two stubs
 * meant two things drifted: a chunk shape one produced and the other could not,
 * and a fix applied to one loop's provider and not the other's. The engine
 * extraction in step 2 of the migration needs a single definition of "a round",
 * because a round is the unit both role loops iterate on.
 *
 * Two things about this file are load-bearing and easy to undo by accident:
 *
 * 1. **The stub is installed before the code under test is imported.** The
 *    OpenAI SDK captures the global `fetch` when it loads. A static import of
 *    `dist/developer/developer.js` above this file would capture the real one and
 *    every stub here would be a no-op. That is why every test using this module
 *    reaches its subject through `await import(pathToFileURL(...).href)`.
 *
 * 2. **A round is `{ toolCalls?, text?, thinking? }`.** An empty round is legal
 *    and means "the model said nothing and asked for nothing" — the Worker
 *    relies on that to leave its loop, and `parallel-tools.test.mjs` depends on
 *    it to end a script. Do not normalise an empty round into a text round.
 */

const realFetch = globalThis.fetch
let handler = null

// The trampoline, installed at module load. Everything else in the suite swaps
// `handler` rather than replacing `globalThis.fetch`, so two doubles can be live
// in one process without fighting over the global.
globalThis.fetch = (...args) => (handler ? handler(...args) : realFetch(...args))

/** Install a fetch handler. Returns a restore function. */
export function useProvider(fn) {
  const previous = handler
  handler = fn
  return () => {
    handler = previous
  }
}

/**
 * One SSE event per chunk. Handing the SDK the whole body as a single string
 * makes its event decoder see one malformed frame — a fake that only works by
 * luck is worse than no fake.
 */
export function sseResponse(payloads) {
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

/** A chunk carrying one streamed tool call. `index` must be distinct per call. */
// `rawArgs` sends the arguments string exactly as given, so a test can send JSON a model might mangle.
export function toolCallChunk({ name, args = {}, rawArgs, index = 0, id = `call_${index}` }) {
  return {
    id: 's',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ index, id, type: 'function', function: { name, arguments: rawArgs ?? JSON.stringify(args) } }],
        },
        finish_reason: null,
      },
    ],
  }
}

export const toolFinish = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
export const stopChunk = { choices: [{ delta: {}, finish_reason: 'stop' }] }

export function textChunk(content) {
  return { choices: [{ delta: { content }, finish_reason: null }] }
}

export function thinkingChunk(content) {
  return {
    choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: content }] }, finish_reason: null }],
  }
}

/** The chunks for one round, in the order the SDK should reassemble them. */
export function roundChunks(round) {
  const chunks = []
  for (const [index, call] of (round.toolCalls ?? []).entries()) {
    chunks.push(toolCallChunk({ ...call, index }))
  }
  if (round.text !== undefined) chunks.push(textChunk(round.text))
  if (round.thinking !== undefined) chunks.push(thinkingChunk(round.thinking))
  if ((round.toolCalls ?? []).length > 0) chunks.push(toolFinish)
  chunks.push(stopChunk)
  return chunks
}

/**
 * Replay a fixed script of rounds. The last round repeats once the script is
 * exhausted, so a test that accidentally runs one round too many still gets a
 * provider rather than a crash.
 *
 * Returns `{ restore }` rather than the bare function, because a test that
 * installs a provider usually wants to hand the restore to `t.after`.
 */
export function scriptedProvider(script) {
  let turn = 0
  return {
    restore: useProvider(async () => {
      const round = script[Math.min(turn, script.length - 1)]
      turn++
      return sseResponse(roundChunks(round ?? {}))
    }),
  }
}

/** The convenience form the older tests used: tool call, then prose. */
export function stubProvider(toolName = 'read_file', args = { path: 'README.md' }, text = 'done') {
  return scriptedProvider([{ toolCalls: [{ name: toolName, args }] }, { text }])
}

/** A streamer that satisfies the Worker loop's SessionStreamer port. */
export function noopStreamer() {
  return {
    onTextDelta() {},
    onThinkingDelta() {},
    finishLine() {},
    discardBuffer() {},
    info() {},
    success() {},
    error() {},
    warning() {},
    newline() {},
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Drop everything that legitimately varies between two identical runs. */
export function normaliseRequest(init) {
  const headers = {}
  for (const [key, value] of Object.entries(init?.headers ?? {})) {
    // Stamped per call in createClient, so it is different on every replay.
    if (key.toLowerCase() === 'x-opencode-session') continue
    headers[key] = value
  }
  let body = null
  if (typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body)
      // The credential is the fixture author's business, never the fixture's.
      delete parsed.tools
      body = { model: parsed.model, messages: parsed.messages, stream: parsed.stream }
    } catch {
      body = init.body
    }
  }
  return { url: init?.url, headers, body }
}

/** Accumulate an SSE byte stream into `{ text, thinking, toolCalls }`. */
async function decodeSse(response) {
  const text = []
  const thinking = []
  const toolCalls = new Map()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let raw = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    raw += chunk
    buffered += chunk
    let split
    while ((split = buffered.indexOf('\n\n')) !== -1) {
      const frame = buffered.slice(0, split)
      buffered = buffered.slice(split + 2)
      const line = frame.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      const delta = payload.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) text.push(delta.content)
      if (delta.reasoning_details) {
        for (const part of delta.reasoning_details) if (part.text) thinking.push(part.text)
      }
      for (const call of delta.tool_calls ?? []) {
        const slot = toolCalls.get(call.index) ?? { name: '', args: '' }
        if (call.function?.name) slot.name += call.function.name
        if (call.function?.arguments) slot.args += call.function.arguments
        toolCalls.set(call.index, slot)
      }
    }
  }
  return { raw, round: { text: text.join(''), thinking: thinking.join(''), toolCalls: [...toolCalls.values()] } }
}

/**
 * Record a live run instead of replaying one.
 *
 * `passthrough: true` (the default) calls the real provider, tees the stream,
 * and writes the fixture. That is the only way to get a fixture that is
 * genuinely representative, and it needs a real `OPENCODE_API_KEY` — the checked
 * in fixtures were authored to represent the shapes those runs take, because no
 * key was available when they were written. Re-record with:
 *
 *   OPENCODE_API_KEY=… node --test test/replay-developer.test.mjs --record
 *
 * The request is normalised before it is stored: the per-call
 * `x-opencode-session` header and the credential never reach the fixture.
 */
export function recordingProvider({ passthrough = true, onRound } = {}) {
  const rounds = []
  return {
    rounds,
    restore: useProvider(async (url, init) => {
      const request = normaliseRequest(init)
      if (!passthrough) throw new Error('recordingProvider without passthrough has nothing to record')
      const response = await realFetch(url, init)
      const { raw, round } = await decodeSse(response)
      const entry = { request, response: { ...round, chunks: raw } }
      rounds.push(entry)
      onRound?.(entry, rounds.length)
      return new Response(raw, { status: response.status, headers: response.headers })
    }),
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'replay')

export function fixturePath(name) {
  return join(FIXTURE_DIR, `${name}.json`)
}

export function loadFixture(name) {
  return JSON.parse(readFileSync(fixturePath(name), 'utf-8'))
}

export function saveFixture(name, fixture) {
  mkdirSync(dirname(fixturePath(name)), { recursive: true })
  writeFileSync(fixturePath(name), `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8')
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * Fields that carry a duration or a wall clock. Stripped before comparison so a
 * replay asserts on *what happened*, not on how fast the machine was.
 */
const VOLATILE_EVENT_FIELDS = new Set(['ms', 'elapsedMs', 'at', 'since'])

/** The comparable shape of an event stream. */
export function eventShape(events) {
  return events.map(event => {
    const out = {}
    for (const [key, value] of Object.entries(event).sort(([a], [b]) => a.localeCompare(b))) {
      if (VOLATILE_EVENT_FIELDS.has(key)) continue
      out[key] = value
    }
    return out
  })
}

/** The comparable shape of a tool-call log: which tool, with what arguments. */
export function callShape(calls) {
  return calls.map(({ tool, args }) => ({ tool, args: args ?? null }))
}

/** A handle that answers from a table and records every call in order. */
export function recordingHandle(answers = {}) {
  const calls = []
  return {
    calls,
    async callTool(tool, args) {
      calls.push({ tool, args })
      const answer = answers[tool]
      if (typeof answer === 'function') return answer(args)
      if (answer !== undefined) return answer
      return 'ok'
    },
  }
}

/** A UI port that records every call, for asserting on the event stream. */
export function recordingUi() {
  const calls = []
  const record = name => (...args) => calls.push([name, ...args])
  return {
    calls,
    onTextDelta: record('onTextDelta'),
    onThinkingDelta: record('onThinkingDelta'),
    finishLine: record('finishLine'),
    discardBuffer: record('discardBuffer'),
    info: record('info'),
    success: record('success'),
    error: record('error'),
    warning: record('warning'),
    newline: record('newline'),
    onTaskEvent: record('onTaskEvent'),
    onAgentEvent: record('onAgentEvent'),
  }
}
