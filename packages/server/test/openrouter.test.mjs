// The OpenRouter client is tested entirely against fixture responses — no
// live API key, no network access. `fetchImpl` is injected so these tests
// exercise the real request-building and response-parsing code, not a mock
// of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletion, streamChatCompletion } from '../dist/agent/openrouter.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Builds a Response whose body is an SSE stream, split into arbitrary
 * byte chunks — not necessarily line-aligned — so the line-buffering logic
 * in consumeSseStream is actually exercised, not just the happy path where
 * every chunk happens to end on a newline. */
function sseResponse(rawText, chunkSize = 7) {
  const bytes = new TextEncoder().encode(rawText)
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize))
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

const baseRequest = {
  apiKey: 'sk-test',
  model: 'openrouter/some-model',
  messages: [{ role: 'user', content: 'hi' }],
}

test('chatCompletion sends the OpenAI-compatible request shape', async () => {
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    })
  }

  const result = await chatCompletion(
    { ...baseRequest, tools: [{ type: 'function', function: { name: 'read_file', description: 'd', parameters: {} } }], toolChoice: 'auto' },
    fetchImpl,
  )

  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test')
  const body = JSON.parse(captured.init.body)
  assert.equal(body.model, 'openrouter/some-model')
  assert.equal(body.stream, false)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.tools[0].function.name, 'read_file')

  assert.equal(result.message.content, 'hello')
  assert.equal(result.finishReason, 'stop')
})

test('chatCompletion surfaces a non-2xx response as an error, not a thrown parse failure', async () => {
  const fetchImpl = async () => new Response('rate limited', { status: 429 })
  await assert.rejects(() => chatCompletion(baseRequest, fetchImpl), /429/)
})

test('chatCompletion rejects a response with no choices', async () => {
  const fetchImpl = async () => jsonResponse({ choices: [] })
  await assert.rejects(() => chatCompletion(baseRequest, fetchImpl), /no choices/)
})

test('chatCompletion parses a non-streaming tool_calls response', async () => {
  const fetchImpl = async () =>
    jsonResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
  const result = await chatCompletion(baseRequest, fetchImpl)
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.message.tool_calls[0].function.name, 'read_file')
})

test('streamChatCompletion accumulates content deltas and calls onTextDelta live', async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo, "}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n'

  const fetchImpl = async () => sseResponse(sse)

  const deltas = []
  const result = await streamChatCompletion(baseRequest, (text) => deltas.push(text), fetchImpl)

  assert.deepEqual(deltas, ['Hel', 'lo, ', 'world'])
  assert.equal(result.message.content, 'Hello, world')
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.message.tool_calls, undefined)
})

test('streamChatCompletion accumulates a tool call fragmented across many deltas', async () => {
  // Mirrors real OpenAI-compatible streaming: id/name arrive once on the
  // first fragment for a given index, `arguments` is a partial JSON string
  // that must be concatenated, not replaced, across every fragment.
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"edit_file","arguments":""}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\""}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a.txt\\",\\"old"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"String\\":\\"x\\",\\"newString\\":\\"y\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'

  const fetchImpl = async () => sseResponse(sse)

  const result = await streamChatCompletion(baseRequest, () => {}, fetchImpl)

  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.message.tool_calls.length, 1)
  const call = result.message.tool_calls[0]
  assert.equal(call.id, 'call_1')
  assert.equal(call.function.name, 'edit_file')
  assert.deepEqual(JSON.parse(call.function.arguments), { path: 'a.txt', oldString: 'x', newString: 'y' })
})

test('streamChatCompletion handles multiple concurrent tool calls by index', async () => {
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"b\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'

  const fetchImpl = async () => sseResponse(sse)
  const result = await streamChatCompletion(baseRequest, () => {}, fetchImpl)

  assert.equal(result.message.tool_calls.length, 2)
  assert.equal(result.message.tool_calls[0].id, 'call_a')
  assert.equal(result.message.tool_calls[1].id, 'call_b')
})

test('streamChatCompletion tolerates a malformed frame without losing the rest of the stream', async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"ok1"}}]}\n\n' +
    'data: {not valid json\n\n' +
    'data: {"choices":[{"delta":{"content":"ok2"}}]}\n\n' +
    'data: [DONE]\n\n'

  const fetchImpl = async () => sseResponse(sse)
  const deltas = []
  const result = await streamChatCompletion(baseRequest, (t) => deltas.push(t), fetchImpl)

  assert.deepEqual(deltas, ['ok1', 'ok2'])
  assert.equal(result.message.content, 'ok1ok2')
})

test('streamChatCompletion surfaces a non-2xx response as an error', async () => {
  const fetchImpl = async () => new Response('bad request', { status: 400 })
  await assert.rejects(() => streamChatCompletion(baseRequest, () => {}, fetchImpl), /400/)
})
