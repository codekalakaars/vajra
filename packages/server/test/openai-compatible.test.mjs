// Tests for the shared OpenAI-compatible provider.
//
// Drives the real provider against a local SSE endpoint, so the streaming
// path — delta accumulation, fragmented tool calls, reasoning, errors — is
// exercised as the agent loops actually use it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { OpenAiCompatibleProvider, isRetryableError } = await import(
  '../dist/agent/providers/openai-compatible.js'
)

/** Serve one canned response; resolves the request body for assertions. */
async function withServer(handler, run) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null })
      handler(req, res)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`

  try {
    return await run(new OpenAiCompatibleProvider('test', baseURL), requests)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Write chunks as server-sent events, then close the stream. */
function sse(chunks) {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

function chunk(delta, extra = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  }
}

const request = {
  apiKey: 'test-key',
  model: 'test-model',
  messages: [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'hello' },
  ],
}

test('sends the OpenAI-compatible request shape', async () => {
  await withServer(sse([chunk({ content: 'hi' })]), async (provider, requests) => {
    await provider.streamChat(request, () => {})

    assert.match(requests[0].url, /\/chat\/completions$/)
    assert.equal(requests[0].body.model, 'test-model')
    assert.equal(requests[0].body.stream, true)
    assert.deepEqual(requests[0].body.messages[0], { role: 'system', content: 'be helpful' })
  })
})

test('accumulates content deltas and reports them live', async () => {
  await withServer(
    sse([chunk({ content: 'Hel' }), chunk({ content: 'lo, ' }), chunk({ content: 'world' })]),
    async (provider) => {
      const deltas = []
      const result = await provider.streamChat(request, (text) => deltas.push(text))

      assert.equal(result.message.content, 'Hello, world')
      assert.deepEqual(deltas, ['Hel', 'lo, ', 'world'])
    },
  )
})

test('reassembles a tool call fragmented across deltas', async () => {
  await withServer(
    sse([
      chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
    ]),
    async (provider) => {
      const result = await provider.streamChat(request, () => {})

      assert.equal(result.message.toolCalls.length, 1)
      assert.deepEqual(result.message.toolCalls[0], {
        id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"a.ts"}',
      })
    },
  )
})

test('keeps concurrent tool calls apart by index', async () => {
  await withServer(
    sse([
      chunk({ tool_calls: [
        { index: 0, id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a' } },
        { index: 1, id: 'call-b', type: 'function', function: { name: 'list_files', arguments: '{"path":"b' } },
      ] }),
      chunk({ tool_calls: [
        { index: 1, function: { arguments: '"}' } },
        { index: 0, function: { arguments: '.ts"}' } },
      ] }),
    ]),
    async (provider) => {
      const result = await provider.streamChat(request, () => {})

      assert.deepEqual(result.message.toolCalls.map((tc) => tc.id), ['call-a', 'call-b'])
      assert.equal(result.message.toolCalls[0].arguments, '{"path":"a.ts"}')
      assert.equal(result.message.toolCalls[1].arguments, '{"path":"b"}')
    },
  )
})

test('reports reasoning deltas separately from content', async () => {
  await withServer(
    sse([
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'thinking...' }] }),
      chunk({ content: 'answer' }),
    ]),
    async (provider) => {
      const text = []
      const thinking = []
      const result = await provider.streamChat(request, (t) => text.push(t), (t) => thinking.push(t))

      assert.deepEqual(thinking, ['thinking...'])
      assert.deepEqual(text, ['answer'])
      assert.equal(result.message.content, 'answer')
    },
  )
})

test('picks up usage from a final chunk with no choice', async () => {
  await withServer(
    sse([
      chunk({ content: 'hi' }),
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
    ]),
    async (provider) => {
      const result = await provider.streamChat(request, () => {})
      assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 2, totalTokens: 13 })
    },
  )
})

test('surfaces a non-2xx response as an error', async () => {
  const handler = (_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'model not found' } }))
  }

  await withServer(handler, async (provider) => {
    await assert.rejects(provider.streamChat(request, () => {}), /model not found/)
  })
})

test('a caller abort stops the request', async () => {
  const handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`)
    // then hang
  }

  await withServer(handler, async (provider) => {
    const caller = new AbortController()
    const pending = provider.streamChat({ ...request, signal: caller.signal }, () => {
      caller.abort(new Error('project stopped'))
    })

    await assert.rejects(pending)
  })
})

test('a daily quota error is not retried, an overload is', () => {
  const quota = Object.assign(new Error('rate limit exceeded: per-day quota'), { status: 429 })
  const burst = Object.assign(new Error('rate limit exceeded'), { status: 429 })
  const gateway = Object.assign(new Error('bad gateway'), { status: 502 })
  const badRequest = Object.assign(new Error('invalid model'), { status: 400 })

  assert.equal(isRetryableError(quota), false)
  assert.equal(isRetryableError(burst), true)
  assert.equal(isRetryableError(gateway), true)
  assert.equal(isRetryableError(badRequest), false)
})
