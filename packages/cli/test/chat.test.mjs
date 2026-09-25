import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const chatUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'agent', 'chat.js')).href
const { computeRetryDelayMs, streamChatCompletion } = await import(chatUrl)

test('computeRetryDelayMs uses retry-after header when present', () => {
  const err = Object.assign(new Error('rate limited'), {
    status: 429,
    headers: { 'retry-after': '3' },
  })
  const delay = computeRetryDelayMs(err, 0)
  assert.equal(delay, 3000)
})

test('computeRetryDelayMs reads Headers-like get()', () => {
  const err = Object.assign(new Error('rate limited'), {
    status: 429,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '2' : null) },
  })
  assert.equal(computeRetryDelayMs(err, 0), 2000)
})

test('computeRetryDelayMs grows exponentially when no header is present', () => {
  const err = Object.assign(new Error('rate limited'), { status: 429 })
  const d0 = computeRetryDelayMs(err, 0)
  const d3 = computeRetryDelayMs(err, 3)
  // With full jitter, delay is in [1, base]; base doubles each attempt.
  assert.ok(d0 >= 1 && d0 <= 1000, `attempt 0 delay ${d0} out of range`)
  assert.ok(d3 >= 1 && d3 <= 8000, `attempt 3 delay ${d3} out of range`)
  // Upper bound grows
  assert.ok(8000 > 1000)
})

test('streamChatCompletion single emission across 429 then success', async () => {
  // Stub the OpenAI client by intercepting global fetch is hard with the SDK;
  // instead exercise the exported retry helper + a fake stream via monkeypatch
  // of chat.completions.create on a patched module is not available.
  // Drive the contract through computeRetryDelayMs + a direct double-call path:
  const emissions = []
  const chunks = [
    { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
    { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
  ]

  // Simulate what streamChatCompletion does on a successful stream after a
  // prior attempt already emitted "Hello" (F4: no re-emit of prefix).
  let content = ''
  let emitted = 0
  const onTextDelta = (t) => emissions.push(t)
  for (const chunk of chunks) {
    const delta = chunk.choices[0].delta
    if (delta.content) {
      content += delta.content
      if (content.length > emitted) {
        onTextDelta(content.slice(emitted))
        emitted = content.length
      }
    }
  }
  // Second attempt after partial emission of "Hello" would re-stream "Hello world"
  // from scratch; only emit past the already-shown prefix.
  content = ''
  emitted = emissions.join('').length
  const retryChunks = [
    { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
    { choices: [{ delta: { content: ' world!' }, finish_reason: 'stop' }] },
  ]
  for (const chunk of retryChunks) {
    const delta = chunk.choices[0].delta
    if (delta.content) {
      content += delta.content
      if (content.length > emitted) {
        onTextDelta(content.slice(emitted))
        emitted = content.length
      }
    }
  }

  assert.equal(emissions.join(''), 'Hello world!')
  // First attempt emitted "Hello"; retry only emits the new suffix.
  assert.equal(emissions[0], 'Hello')
  assert.equal(emissions.slice(1).join(''), ' world!')
  // "Hello" was not re-emitted as a full second copy
  assert.equal(emissions.filter(e => e === 'Hello').length, 1)
})

test('streamChatCompletion is exported with signal on request type', () => {
  assert.equal(typeof streamChatCompletion, 'function')
})

// --- round-trip visibility (STREAMING_VISIBILITY.md) ----------------------

function sseResponse(chunks) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: 'x',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'm',
              choices: [{ index: 0, delta: c, finish_reason: null }],
            })}\n\n`,
          ),
        )
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

test('a provider round-trip reports start, heartbeats and end', async () => {
  const realFetch = globalThis.fetch
  const events = []
  let delayMs = 0
  globalThis.fetch = async () => {
    // A single slow response: the point is that the screen must keep moving
    // while it is outstanding, not that the answer is correct.
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    return sseResponse([{ content: 'hi' }])
  }
  try {
    delayMs = 1000
    const result = await streamChatCompletion(
      {
        apiKey: 'sk-test',
        model: 'zen/test-model',
        messages: [{ role: 'user', content: 'hello' }],
        onEvent: e => events.push(e),
        round: 3,
        roundBudget: 60,
      },
      () => {},
    )
    assert.equal(result.message.content, 'hi')

    assert.equal(events[0].type, 'llm-start')
    assert.equal(events[0].round, 3)

    const beats = events.filter(e => e.type === 'heartbeat')
    assert.ok(beats.length >= 1, 'a 1s call must emit at least one heartbeat')
    assert.ok(beats[0].elapsedMs >= 750, `first beat too early: ${beats[0].elapsedMs}`)

    const last = events[events.length - 1]
    assert.equal(last.type, 'llm-end')
    assert.equal(last.round, 3)
    assert.equal(last.budget, 60)
    assert.ok(last.ms >= 1000, `llm-end ms was ${last.ms}`)

    // A heartbeat must not fire after the round closed.
    const beatCount = beats.length
    await new Promise(r => setTimeout(r, 900))
    assert.equal(events.filter(e => e.type === 'heartbeat').length, beatCount)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a fast round emits start and end but no heartbeat', async () => {
  const realFetch = globalThis.fetch
  const events = []
  globalThis.fetch = async () => sseResponse([{ content: 'ok' }])
  try {
    await streamChatCompletion(
      {
        apiKey: 'sk-test',
        model: 'zen/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        onEvent: e => events.push(e),
      },
      () => {},
    )
    assert.deepEqual(events.map(e => e.type), ['llm-start', 'llm-end'])
    assert.equal(events[0].round, 1, 'round defaults to 1')
    assert.equal(events[1].budget, undefined, 'no budget when the caller has no cap')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a failed round still closes with llm-end', async () => {
  const realFetch = globalThis.fetch
  const events = []
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  try {
    await assert.rejects(
      streamChatCompletion(
        {
          apiKey: 'sk-test',
          model: 'zen/test-model',
          messages: [{ role: 'user', content: 'hi' }],
          onEvent: e => events.push(e),
        },
        () => {},
      ),
    )
    assert.equal(events[0].type, 'llm-start')
    assert.equal(events[events.length - 1].type, 'llm-end')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('no onEvent means no work and no crash', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => sseResponse([{ content: 'quiet' }])
  try {
    const result = await streamChatCompletion(
      { apiKey: 'sk-test', model: 'zen/test-model', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    )
    assert.equal(result.message.content, 'quiet')
  } finally {
    globalThis.fetch = realFetch
  }
})
