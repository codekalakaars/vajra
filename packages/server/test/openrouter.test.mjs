// The OpenRouter client is tested by mocking globalThis.fetch — no live API
// key, no network access.  The OpenAI SDK delegates to fetch internally,
// so we intercept at that level.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletion, streamChatCompletion } from '../dist/agent/openrouter.js'

const baseRequest = {
  apiKey: 'sk-test',
  model: 'openrouter/some-model',
  messages: [{ role: 'user', content: 'hi' }],
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

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

// --- chatCompletion tests ---

test('chatCompletion sends the OpenAI-compatible request shape', async () => {
  let captured
  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async (url, init) => {
    captured = { url, init }
    return jsonResponse({
      id: 'cmpl-test',
      object: 'chat.completion',
      created: Date.now(),
      model: 'test',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  })

  try {
    const result = await chatCompletion({
      ...baseRequest,
      tools: [{ type: 'function', function: { name: 'read_file', description: 'd', parameters: {} } }],
      toolChoice: 'auto',
    })

    assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions')
    const body = JSON.parse(captured.init.body)
    assert.equal(body.model, 'openrouter/some-model')
    assert.equal(body.messages[0].role, 'user')
    assert.equal(body.messages[0].content, 'hi')
    assert.equal(body.tools[0].function.name, 'read_file')
    assert.equal(body.tool_choice, 'auto')

    assert.equal(result.message.content, 'hello')
    assert.equal(result.finishReason, 'stop')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('chatCompletion surfaces a non-2xx response as an error', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () => new Response('rate limited', { status: 429 }))
  try {
    await assert.rejects(() => chatCompletion(baseRequest), /429/)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('chatCompletion rejects a response with no choices', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () =>
    jsonResponse({ id: 'cmpl-test', choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }),
  )
  try {
    await assert.rejects(() => chatCompletion(baseRequest), /no choices/)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('chatCompletion parses a non-streaming tool_calls response', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () =>
    jsonResponse({
      id: 'cmpl-test',
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
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  )
  try {
    const result = await chatCompletion(baseRequest)
    assert.equal(result.finishReason, 'tool_calls')
    assert.equal(result.message.tool_calls[0].function.name, 'read_file')
  } finally {
    globalThis.fetch = origFetch
  }
})

// --- streamChatCompletion tests ---

test('streamChatCompletion accumulates content deltas and calls onTextDelta live', async () => {
  const sse =
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"lo, "}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"world"}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n'

  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () => sseResponse(sse))
  try {
    const deltas = []
    const result = await streamChatCompletion(baseRequest, (text) => deltas.push(text))

    assert.deepEqual(deltas, ['Hel', 'lo, ', 'world'])
    assert.equal(result.message.content, 'Hello, world')
    assert.equal(result.finishReason, 'stop')
    assert.equal(result.message.tool_calls, undefined)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('streamChatCompletion accumulates a tool call fragmented across many deltas', async () => {
  const sse =
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"edit_file","arguments":""}}]}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\""}}]}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a.txt\\",\\"old"}}]}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"String\\":\\"x\\",\\"newString\\":\\"y\\"}"}}]}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'

  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () => sseResponse(sse))
  try {
    const result = await streamChatCompletion(baseRequest, () => {})

    assert.equal(result.finishReason, 'tool_calls')
    assert.equal(result.message.tool_calls.length, 1)
    const call = result.message.tool_calls[0]
    assert.equal(call.id, 'call_1')
    assert.equal(call.function.name, 'edit_file')
    assert.deepEqual(JSON.parse(call.function.arguments), { path: 'a.txt', oldString: 'x', newString: 'y' })
  } finally {
    globalThis.fetch = origFetch
  }
})

test('streamChatCompletion handles multiple concurrent tool calls by index', async () => {
  const sse =
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"b\\"}"}}]}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'

  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () => sseResponse(sse))
  try {
    const result = await streamChatCompletion(baseRequest, () => {})

    assert.equal(result.message.tool_calls.length, 2)
    assert.equal(result.message.tool_calls[0].id, 'call_a')
    assert.equal(result.message.tool_calls[1].id, 'call_b')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('streamChatCompletion calls onThinkingDelta for reasoning tokens', async () => {
  const sse =
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.text","text":"thinking 1"}]}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.text","text":"thinking 2"}]}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n' +
    'data: {"id":"cmpl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n'

  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () => sseResponse(sse))
  try {
    const textDeltas = []
    const thinkingDeltas = []
    const result = await streamChatCompletion(
      baseRequest,
      (t) => textDeltas.push(t),
      (t) => thinkingDeltas.push(t),
    )

    assert.deepEqual(thinkingDeltas, ['thinking 1', 'thinking 2'])
    assert.deepEqual(textDeltas, ['answer'])
    assert.equal(result.message.content, 'answer')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('streamChatCompletion surfaces a non-2xx response as an error', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = mock.fn(async () => new Response('bad request', { status: 400 }))
  try {
    await assert.rejects(() => streamChatCompletion(baseRequest, () => {}), /400/)
  } finally {
    globalThis.fetch = origFetch
  }
})
