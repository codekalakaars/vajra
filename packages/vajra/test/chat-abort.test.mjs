import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
// Installed before the subject loads: the SDK captures `fetch` when it does.
import { useProvider } from './_provider.mjs'

const { streamChatCompletion } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'dist', 'model', 'chat.js')).href
)

/** A provider that accepts the request and never answers it. */
function hangingProvider(seen) {
  return (_url, init) => {
    seen.push(init)
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }
}

test('an abort stops a round the provider never answers', async () => {
  const seen = []
  const restore = useProvider(hangingProvider(seen))
  try {
    const startedAt = Date.now()
    await assert.rejects(
      streamChatCompletion(
        { apiKey: 'sk-test', model: 'zen/x', messages: [{ role: 'user', content: 'hi' }], signal: AbortSignal.timeout(200) },
        () => {},
      ),
      err => err instanceof Error && err.name === 'AbortError',
    )
    assert.ok(Date.now() - startedAt < 5_000, 'the abort must end the round, not the provider')
  } finally {
    restore()
  }
})

test('signal and timeout are request options, never fields of the request body', async () => {
  const seen = []
  const restore = useProvider(hangingProvider(seen))
  try {
    await assert.rejects(
      streamChatCompletion(
        { apiKey: 'sk-test', model: 'zen/x', messages: [{ role: 'user', content: 'hi' }], signal: AbortSignal.timeout(100) },
        () => {},
      ),
    )
    assert.equal(seen.length, 1)
    const body = JSON.parse(seen[0].body)
    assert.equal('signal' in body, false)
    assert.equal('timeout' in body, false)
  } finally {
    restore()
  }
})

// --- a request that goes quiet is sent again ---------------------------------

import { sseResponse, textChunk, stopChunk } from './_provider.mjs'

const encoder = new TextEncoder()
const sse = chunk => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)

/** An SSE response that sends `chunks` on a timer, then either finishes or goes quiet until aborted. */
function streamingResponse(init, chunks, { everyMs = 0, hang = false } = {}) {
  return new Response(
    new ReadableStream({
      async start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
        for (const chunk of chunks) {
          if (everyMs) await new Promise(resolve => setTimeout(resolve, everyMs))
          controller.enqueue(sse(chunk))
        }
        if (!hang) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const ask = extra =>
  streamChatCompletion(
    { apiKey: 'sk-test', model: 'zen/x', messages: [{ role: 'user', content: 'hi' }], ...extra },
    () => {},
  )

test('a request that goes quiet mid-stream is abandoned and the round is sent again', async () => {
  let calls = 0
  const restore = useProvider((_url, init) => {
    calls++
    return Promise.resolve(
      calls === 1
        ? streamingResponse(init, [textChunk('par')], { hang: true })
        : streamingResponse(init, [textChunk('whole answer'), stopChunk]),
    )
  })
  try {
    const startedAt = Date.now()
    const stalls = []
    const result = await ask({ stallMs: 200, onEvent: event => { if (event.type === 'llm-stall') stalls.push(event) } })
    assert.equal(calls, 2, 'the round was sent again')
    assert.deepEqual(stalls, [{ type: 'llm-stall', round: 1, afterMs: 200 }], 'the stall was reported')
    assert.equal(result.message.content, 'whole answer', 'nothing from the stalled attempt leaked in')
    assert.ok(Date.now() - startedAt < 4_000, 'it did not wait for the 120 s default')
  } finally {
    restore()
  }
})

test('a stream that keeps sending is never cut, however long the whole answer takes', async () => {
  let calls = 0
  const restore = useProvider((_url, init) => {
    calls++
    // Six chunks 120 ms apart: 720 ms in all, with no gap near the 400 ms window.
    const chunks = [...'abcde'].map(textChunk).concat([stopChunk])
    return Promise.resolve(streamingResponse(init, chunks, { everyMs: 120 }))
  })
  try {
    const result = await ask({ stallMs: 400 })
    assert.equal(calls, 1, 'one request, never re-sent')
    assert.equal(result.message.content, 'abcde')
  } finally {
    restore()
  }
})

test('a model that never answers ends with a clear error, not a hang', async () => {
  let calls = 0
  const restore = useProvider((_url, init) => {
    calls++
    return Promise.resolve(streamingResponse(init, [], { hang: true }))
  })
  try {
    await assert.rejects(ask({ stallMs: 50 }), /did not answer for 0s|did not answer/)
    assert.ok(calls > 1, `it was tried more than once (${calls})`)
  } finally {
    restore()
  }
})

test('the caller\'s own abort still ends the round at once, and is not mistaken for a stall', async () => {
  const restore = useProvider((_url, init) => Promise.resolve(streamingResponse(init, [], { hang: true })))
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(ask({ stallMs: 10_000, signal: controller.signal }), err => err.name === 'AbortError')
  } finally {
    restore()
  }
})
