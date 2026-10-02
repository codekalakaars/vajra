import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = join(import.meta.dirname, '..', 'dist')
const { capToolOutput } = await import(pathToFileURL(join(dist, 'tasks', 'output-cap.js')).href)
const { parseCommandResult } = await import(pathToFileURL(join(dist, 'tasks', 'execute.js')).href)
const { compressMessages } = await import(pathToFileURL(join(dist, 'agent', 'developer.js')).href)
const { getModelLimit } = await import(pathToFileURL(join(dist, 'agent', 'context-window.js')).href)

test('a result under the cap is untouched', () => {
  assert.equal(capToolOutput('read_file', 'short', 1000), 'short')
  const command = JSON.stringify({ exitCode: 0, signal: null, stdout: 'ok', stderr: '' })
  assert.equal(capToolOutput('run_command', command, 1000), command)
})

test('command output keeps its end, where the failure is, and still parses', () => {
  const stdout = `${'noise line\n'.repeat(5000)}FAIL test/a.test.js: expected 2, got 3\n`
  const raw = JSON.stringify({ exitCode: 1, signal: null, stdout, stderr: '' })
  const capped = capToolOutput('run_command', raw, 4000)
  assert.ok(capped.length <= 4200, `capped to ${capped.length}`)
  const parsed = JSON.parse(capped)
  assert.equal(parsed.exitCode, 1)
  assert.match(parsed.stdout, /FAIL test\/a\.test\.js: expected 2, got 3\n$/)
  assert.match(parsed.stdout, /earlier characters cut; this is the end of the output/)
  assert.equal(parseCommandResult(capped).exitCode, 1)
})

test('a short stderr is kept whole and stdout gets the rest of the budget', () => {
  const raw = JSON.stringify({ exitCode: 2, signal: null, stdout: 'x'.repeat(50_000), stderr: 'Error: boom' })
  const parsed = JSON.parse(capToolOutput('run_command', raw, 5000))
  assert.equal(parsed.stderr, 'Error: boom')
  assert.ok(parsed.stdout.length > 4000, `stdout kept ${parsed.stdout.length}`)
})

test('a file keeps its beginning and says how to read the rest', () => {
  const content = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`).join('\n')
  const capped = capToolOutput('read_file', content, 2000)
  assert.ok(capped.startsWith('line 1\nline 2\n'))
  assert.match(capped, /showing the first 2,000 of [\d,]+ characters\. Call read_file with offset and limit/)
})

test('compressMessages keeps pinned leading messages whatever their role', () => {
  const model = 'zen/unknown-for-this-test'
  const window = getModelLimit(model)
  // Each unit is a third of the window, so only the latest one or two fit.
  const big = 'y'.repeat(Math.floor((window * 4) / 3))
  const messages = [
    { role: 'system', content: 'you are a worker' },
    { role: 'user', content: 'TASK: fix the bug' },
  ]
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
    messages.push({ role: 'tool', content: big, tool_call_id: `c${i}` })
  }
  const unpinned = compressMessages(messages, model, 2000)
  assert.equal(unpinned.some(m => m.content === 'TASK: fix the bug'), false, 'without a pin the task is dropped first')

  const pinned = compressMessages(messages, model, 2000, 2)
  assert.deepEqual(pinned.slice(0, 2), messages.slice(0, 2))
  assert.ok(pinned.length < messages.length)
  assert.equal(pinned.at(-1).tool_call_id, 'c5', 'the latest exchange is the one kept')
})
