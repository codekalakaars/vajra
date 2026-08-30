import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getToolSpecs, parseToolCall } from '../dist/agent/tools.js'

test('getToolSpecs matches the protocol package tool count', () => {
  const specs = getToolSpecs()
  assert.equal(specs.length, 3)
  assert.ok(specs.every((s) => s.type === 'function'))
  assert.ok(!specs.some((s) => s.function.name === 'run_shell'))
})

test('parseToolCall accepts a well-formed call', () => {
  const result = parseToolCall({
    id: 'call_1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
  })

  assert.equal(result.ok, true)
  assert.equal(result.call.callId, 'call_1')
  assert.equal(result.call.tool, 'read_file')
  assert.deepEqual(result.call.args, { path: 'a.txt' })
})

test('parseToolCall rejects an unknown tool name without throwing', () => {
  const result = parseToolCall({
    id: 'call_2',
    type: 'function',
    function: { name: 'delete_everything', arguments: '{}' },
  })

  assert.equal(result.ok, false)
  assert.equal(result.callId, 'call_2')
  assert.match(result.error, /Unknown tool/)
})

test('parseToolCall rejects non-JSON arguments the model might hallucinate', () => {
  const result = parseToolCall({
    id: 'call_3',
    type: 'function',
    function: { name: 'read_file', arguments: 'not json' },
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /not valid JSON/)
})

test('parseToolCall rejects arguments that fail the tool schema', () => {
  const result = parseToolCall({
    id: 'call_4',
    type: 'function',
    // search_files requires query; missing here.
    function: { name: 'search_files', arguments: '{}' },
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /Invalid arguments/)
})

test('parseToolCall never crashes on run_shell, which was deliberately excluded', () => {
  const result = parseToolCall({
    id: 'call_5',
    type: 'function',
    function: { name: 'run_shell', arguments: '{"command":"echo hi"}' },
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /Unknown tool/)
})
