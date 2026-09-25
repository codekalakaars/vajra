import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'

const executeUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tasks', 'execute.js')).href
const serverUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tasks', 'server.js')).href
const { parseCommandResult } = await import(executeUrl)
const { allocateServerPort, probeServerPort, substituteServerPort } = await import(serverUrl)

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

test('allocates distinct usable ephemeral validation-server ports', async () => {
  const ports = await Promise.all([allocateServerPort(), allocateServerPort()])
  assert.ok(ports.every(port => Number.isInteger(port) && port > 0))
  assert.notEqual(ports[0], ports[1])
})

test('detects when a validation server is listening', async () => {
  const port = await allocateServerPort()
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  try {
    assert.equal(await probeServerPort(port), true)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('substitutes the allocated port into local validation targets', () => {
  assert.equal(
    substituteServerPort('curl http://localhost:3000/health', 43127),
    'curl http://localhost:43127/health',
  )
  assert.equal(
    substituteServerPort('curl http://127.0.0.1/health', 43127),
    'curl http://127.0.0.1:43127/health',
  )
  assert.equal(
    substituteServerPort('node -e "process.stdout.write(String(process.env.PORT))"', 43127),
    'node -e "process.stdout.write(String(43127))"',
  )
  assert.equal(
    substituteServerPort('curl http://localhost:${PORT}/health', 43127),
    'curl http://localhost:43127/health',
  )
  assert.equal(
    substituteServerPort('node -e "fetch(\'http://localhost:\' + process.env.PORT)"', 43127),
    'node -e "fetch(\'http://localhost:\' + 43127)"',
  )
})
