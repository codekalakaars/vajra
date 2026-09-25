// Tests for agent/context.ts — token-aware compression.
//
// The invariant that matters: whatever comes out must still be a valid
// transcript. Every `tool` message needs the assistant message carrying its
// tool_call id, and every tool call needs a result — providers reject the
// alternatives with a 400.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compressMessages, estimateTokens, getModelLimit } from '../dist/agent/context.js'

/** Build a message big enough to blow the budget on its own terms. */
function filler(chars) {
  return 'x'.repeat(chars)
}

/** One assistant tool-call turn plus its answer. */
function toolExchange(id, resultChars = 4000) {
  return [
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ path: `${id}.ts` }) }],
    },
    { role: 'tool', content: filler(resultChars), toolCallId: id },
  ]
}

/**
 * Assert the transcript is well-formed: no orphan tool results, no
 * unanswered tool calls.
 */
function assertWellFormed(messages) {
  const answered = new Set()
  for (const message of messages) {
    if (message.role === 'tool') {
      answered.add(message.toolCallId)
    }
  }

  const requested = new Set()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      requested.add(call.id)
      assert.ok(
        answered.has(call.id),
        `tool call ${call.id} has no matching tool result`,
      )
    }
  }

  for (const message of messages) {
    if (message.role !== 'tool') continue
    assert.ok(
      requested.has(message.toolCallId),
      `tool result ${message.toolCallId} has no matching tool call`,
    )
  }
}

test('returns the array untouched when under the limit', () => {
  const messages = [
    { role: 'system', content: 'you are a helpful agent' },
    { role: 'user', content: 'hello' },
  ]

  assert.equal(compressMessages(messages, 'gpt-5.5'), messages)
})

test('never splits a tool call from its result', () => {
  const messages = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'user', content: `request ${i}` })
    messages.push(...toolExchange(`call-${i}`, 20000))
  }

  const compressed = compressMessages(messages, 'kimi-k3')

  assert.ok(compressed.length < messages.length, 'expected compression to drop messages')
  assertWellFormed(compressed)
})

test('keeps the transcript under the model limit', () => {
  const messages = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 60; i++) {
    messages.push({ role: 'user', content: filler(6000) })
    messages.push(...toolExchange(`call-${i}`, 12000))
  }

  const model = 'kimi-k3'
  const compressed = compressMessages(messages, model)
  const total = compressed.reduce((sum, m) => sum + estimateTokens(m), 0)

  assert.ok(
    total <= getModelLimit(model) - 2000,
    `compressed transcript is ${total} tokens, over the budget`,
  )
})

test('does not mutate the caller history', () => {
  const messages = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: filler(9000) })
    messages.push(...toolExchange(`call-${i}`, 9000))
  }
  const before = messages.length
  const firstToolResult = messages[2].content

  compressMessages(messages, 'kimi-k3')

  assert.equal(messages.length, before)
  assert.equal(messages[2].content, firstToolResult)
})

test('keeps every system message and opens with one', () => {
  const messages = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: filler(9000) })
    messages.push(...toolExchange(`call-${i}`, 9000))
  }

  const compressed = compressMessages(messages, 'kimi-k3')

  assert.equal(compressed[0].role, 'system')
  assert.equal(compressed.filter((m) => m.role === 'system').length, 1)
})

test('does not stack a compression notice every pass', () => {
  const messages = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'user', content: filler(9000) })
    messages.push(...toolExchange(`call-${i}`, 9000))
  }

  const once = compressMessages(messages, 'kimi-k3')
  const twice = compressMessages(once, 'kimi-k3')

  const notices = (list) =>
    list.filter((m) => typeof m.content === 'string' && m.content.includes('compressed to fit context window')).length

  assert.equal(notices(once), 1)
  assert.ok(notices(twice) <= 1, 'notices accumulated across compression passes')
})

test('truncates an oversized final exchange rather than dropping it', () => {
  const model = 'kimi-k3'
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do the thing' },
    ...toolExchange('huge', getModelLimit(model) * 8),
  ]

  const compressed = compressMessages(messages, model)

  assertWellFormed(compressed)
  const toolResult = compressed.find((m) => m.role === 'tool')
  assert.ok(toolResult, 'the final tool result should survive')
  assert.ok(toolResult.content.endsWith('... (truncated)'), 'expected truncation')
})
