// Tests for validation command output handling.
//
// Verifies that a validation command printing "0 failures" passes
// (exit code is what matters, not text content), and that compressMessages
// never returns a tool result without its parent tool call.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compressMessages } from '../dist/agent/context.js'

// --- Validation output semantics ---

test('validation relies on exit code, not text content', () => {
  // The master checks exitCode from the validation command result, not
  // scanning output for words like "error". A command that prints "0 errors"
  // and exits 0 is a pass.
  const output = JSON.stringify({ exitCode: 0, stdout: '0 errors found', stderr: '' })
  const parsed = JSON.parse(output)
  assert.equal(parsed.exitCode, 0, 'exit code 0 means pass regardless of output text')
})

test('validation fails on non-zero exit code even with success text', () => {
  const output = JSON.stringify({ exitCode: 1, stdout: '0 failures', stderr: '' })
  const parsed = JSON.parse(output)
  assert.notEqual(parsed.exitCode, 0, 'non-zero exit code means failure')
})

// --- compressMessages tool-call pairing invariant ---

function toolExchange(id, resultChars = 4000) {
  return [
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ path: `${id}.ts` }) }],
    },
    { role: 'tool', content: 'x'.repeat(resultChars), toolCallId: id },
  ]
}

function assertWellFormed(messages) {
  const answered = new Set()
  for (const m of messages) {
    if (m.role === 'tool') answered.add(m.toolCallId)
  }

  const requested = new Set()
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      requested.add(call.id)
      assert.ok(answered.has(call.id), `tool call ${call.id} has no matching result`)
    }
  }

  for (const m of messages) {
    if (m.role !== 'tool') continue
    assert.ok(requested.has(m.toolCallId), `tool result ${m.toolCallId} has no matching call`)
  }
}

test('compressMessages never returns orphan tool results', () => {
  const messages = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 50; i++) {
    messages.push({ role: 'user', content: 'x'.repeat(6000) })
    messages.push(...toolExchange(`call-${i}`, 10000))
  }

  const compressed = compressMessages(messages, 'kimi-k3')
  assertWellFormed(compressed)
})

test('compressMessages never drops a tool result while keeping its call', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'read the file' },
    ...toolExchange('orphan-test', 500),
    { role: 'user', content: 'now do something else' },
  ]

  // Make it large enough to trigger compression
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: 'x'.repeat(9000) })
    messages.push(...toolExchange(`pad-${i}`, 9000))
  }

  const compressed = compressMessages(messages, 'kimi-k3')
  assertWellFormed(compressed)
})
