import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const developerUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'agent', 'developer.js')).href
const { compressMessages } = await import(developerUrl)

function unitAssistant(id, toolIds) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: toolIds.map(tid => ({
      id: tid,
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/x.ts' }) },
    })),
  }
}

function toolResult(id, content) {
  return { role: 'tool', tool_call_id: id, content }
}

test('short histories pass through unchanged', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]
  const out = compressMessages(messages, 'openai/gpt-4o-mini')
  assert.deepEqual(out, messages)
})

test('never leaves an unanswered tool_call_id dangling', () => {
  // Build a history that forces compression (huge tool payloads) under a tiny
  // reserve so only the most recent complete units survive.
  const messages = [{ role: 'system', content: 'sys ' + 'x'.repeat(8000) }]
  for (let i = 0; i < 40; i++) {
    const id = `call-${i}`
    messages.push(unitAssistant(id, [id]))
    messages.push(toolResult(id, 'y'.repeat(4000)))
  }
  messages.push({ role: 'user', content: 'continue' })

  const out = compressMessages(messages, 'openai/gpt-4o-mini', 1000)

  const answered = new Set()
  const callIds = new Set()
  for (const msg of out) {
    if (msg.role === 'tool' && msg.tool_call_id) answered.add(msg.tool_call_id)
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) callIds.add(tc.id)
    }
  }

  // Every assistant tool_call in the output has a matching tool result.
  for (const id of callIds) {
    assert.ok(answered.has(id), `dangling tool_call ${id} has no result`)
  }
  // Every tool result in the output has a parent assistant.
  for (const id of answered) {
    assert.ok(callIds.has(id), `orphan tool result ${id} has no parent assistant`)
  }
  // Truncation preferred over dropping the unit's tail user message entirely.
  assert.ok(out.some(m => m.role === 'assistant' && m.tool_calls))
})

test('drops incomplete units (assistant without tool results) rather than emit them', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    unitAssistant('orphan', ['orphan']),
    // no tool result for orphan
    { role: 'user', content: 'hi' },
  ]
  // Even when under budget, incomplete assistant tool_call units are dropped.
  const out = compressMessages(messages, 'openai/gpt-4o-mini', 1000)
  for (const msg of out) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        assert.ok(
          out.some(m => m.role === 'tool' && m.tool_call_id === tc.id),
          'assistant with tool_calls must not be emitted without results',
        )
      }
    }
  }
  assert.ok(out.some(m => m.role === 'system'))
  assert.ok(out.some(m => m.role === 'user'))
  assert.ok(!out.some(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === 'orphan')))

  // Same under compression pressure.
  const big = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 80; i++) {
    const id = `big-${i}`
    big.push(unitAssistant(id, [id]))
    big.push(toolResult(id, 'w'.repeat(3000)))
  }
  big.push(unitAssistant('incomplete', ['incomplete']))
  big.push({ role: 'user', content: 'continue' })

  const compressed = compressMessages(big, 'openai/gpt-4o-mini', 1000)
  for (const msg of compressed) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        assert.ok(
          compressed.some(m => m.role === 'tool' && m.tool_call_id === tc.id),
          'assistant with tool_calls must not be emitted without results',
        )
      }
    }
  }
})

test('keeps system prompt when compressing', () => {
  const messages = [{ role: 'system', content: 'system prompt' }]
  for (let i = 0; i < 50; i++) {
    const id = `t${i}`
    messages.push(unitAssistant(id, [id]))
    messages.push(toolResult(id, 'z'.repeat(5000)))
  }
  const out = compressMessages(messages, 'openai/gpt-4o-mini', 500)
  assert.equal(out[0].role, 'system')
  assert.equal(out[0].content, 'system prompt')
})
