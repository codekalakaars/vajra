import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const executeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tasks', 'execute.js')).href
const { parseCommandResult } = await import(executeUrl)

test('parses a successful C1 result', () => {
  const raw = JSON.stringify({ exitCode: 0, signal: null, stdout: 'ok\n', stderr: '' })
  const parsed = parseCommandResult(raw)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.exitCode, 0)
  assert.equal(parsed.signal, null)
  assert.equal(parsed.stdout, 'ok\n')
})

test('non-zero exitCode is a failure', () => {
  const raw = JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: 'boom' })
  const parsed = parseCommandResult(raw)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.exitCode, 1)
})

test('non-null signal is a failure even with exitCode 0', () => {
  const raw = JSON.stringify({ exitCode: 0, signal: 'SIGTERM', stdout: '', stderr: '' })
  const parsed = parseCommandResult(raw)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.signal, 'SIGTERM')
})

test('malformed JSON is never treated as success (no exitCode=0 fallback)', () => {
  const parsed = parseCommandResult('just some output')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.exitCode, -1)
  assert.match(parsed.stderr, /JSON|Malformed/)
})

test('JSON missing exitCode is a failure', () => {
  const parsed = parseCommandResult(JSON.stringify({ stdout: 'hi' }))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.exitCode, -1)
})

test('timeout-style exit 124 fails validation', () => {
  const raw = JSON.stringify({ exitCode: 124, signal: null, stdout: '', stderr: 'Command timed out' })
  const parsed = parseCommandResult(raw)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.exitCode, 124)
})
