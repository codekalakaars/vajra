import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const uiUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'session', 'ui.js')).href
const handleUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tools', 'handle.js')).href
const {
  agentKey,
  agentDisplay,
  formatElapsed,
  startHeartbeat,
  summarizePlanTaskCount,
  summarizeToolCall,
  summarizeToolResult,
} = await import(uiUrl)
const { createToolHandle } = await import(handleUrl)

const DEV = { role: 'developer' }
const WORKER = { role: 'worker', taskId: 'task-1', title: 'auth-mw' }

test('agentKey separates the developer from workers by task id', () => {
  assert.equal(agentKey(DEV), 'developer')
  assert.equal(agentKey(WORKER), 'task-1')
  assert.equal(agentKey({ role: 'worker' }), 'worker')
})

test('agentDisplay names a worker by title, then id, then role', () => {
  assert.equal(agentDisplay(DEV), 'developer')
  assert.equal(agentDisplay(WORKER), 'auth-mw')
  assert.equal(agentDisplay({ role: 'worker', taskId: 'task-9' }), 'task-9')
  assert.equal(agentDisplay({ role: 'worker' }), 'worker')
})

test('formatElapsed never prints a raw millisecond count past a second', () => {
  assert.equal(formatElapsed(0), '0ms')
  assert.equal(formatElapsed(250), '250ms')
  assert.equal(formatElapsed(2400), '2.4s')
  assert.equal(formatElapsed(59_900), '59.9s')
  assert.equal(formatElapsed(60_000), '1m 00s')
  assert.equal(formatElapsed(65_000), '1m 05s')
  // A clock that went backwards must not print a negative age.
  assert.equal(formatElapsed(-5), '0ms')
  assert.equal(formatElapsed(Number.NaN), '0ms')
})

test('summarizePlanTaskCount counts tasks and stays empty on unreadable args', () => {
  assert.equal(summarizePlanTaskCount({ tasks: [1, 2, 3] }), '3 tasks')
  assert.equal(summarizePlanTaskCount({ tasks: [1] }), '1 task')
  assert.equal(summarizePlanTaskCount({}), '')
  assert.equal(summarizePlanTaskCount(undefined), '')
  assert.equal(summarizePlanTaskCount({ tasks: 'nope' }), '')
})

test('startHeartbeat fires on an interval and stops when told', async () => {
  const events = []
  const stop = startHeartbeat(e => events.push(e), WORKER, 10)
  await new Promise(resolve => setTimeout(resolve, 55))
  stop()
  const seen = events.length
  assert.ok(seen >= 2, `expected repeated heartbeats, got ${seen}`)
  assert.equal(events[0].type, 'heartbeat')
  assert.equal(events[0].agent, WORKER)
  assert.ok(events[0].elapsedMs >= 0)

  // Stopped means stopped: no timer is left running.
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(events.length, seen)
})

test('summarizeToolCall shows the one argument worth seeing, project-relative', () => {
  const dir = '/home/dev/proj'
  assert.equal(summarizeToolCall('read_file', { path: '/home/dev/proj/src/run.ts' }, dir), 'src/run.ts')
  assert.equal(summarizeToolCall('edit_file', { path: './src/run.ts' }, dir), 'src/run.ts')
  assert.equal(summarizeToolCall('delete_file', { path: '/etc/passwd' }, dir), 'passwd')
  assert.equal(summarizeToolCall('list_files', {}, dir), '.')
  assert.equal(summarizeToolCall('search_content', { query: 'acquireOrWait' }, dir), '"acquireOrWait"')
  assert.equal(summarizeToolCall('run_command', { command: 'pnpm test' }, dir), 'pnpm test')
  // A long command line is truncated, never wrapped into the next line.
  const long = summarizeToolCall('run_command', { command: 'x'.repeat(200) }, dir)
  assert.equal(long.length, 60)
  assert.ok(long.endsWith('…'))
})

test('summarizeToolCall collapses whitespace so one call stays one line', () => {
  const summary = summarizeToolCall('run_command', { command: 'npm   run\n  build' }, '/p')
  assert.equal(summary, 'npm run build')
})

test('summarizeToolResult reports size for read_file, never its contents', () => {
  const small = summarizeToolResult('read_file', {}, 'abc', 1)
  assert.equal(small.ok, true)
  assert.equal(small.detail, '3 B')

  const big = summarizeToolResult('read_file', {}, 'x'.repeat(4300), 1)
  assert.equal(big.detail, '4.2 KB')
  assert.ok(!big.detail.includes('x'))
})

test('summarizeToolResult calls a masked read "masked" and leaks nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-ui-'))
  try {
    writeFileSync(join(dir, '.env'), 'SECRET_TOKEN=super-secret-value\n')
    const handle = createToolHandle(dir)
    const result = await handle.callTool('read_file', { path: '.env' })
    assert.ok(!String(result).includes('super-secret-value'), 'masked read must not return contents')

    const outcome = summarizeToolResult('read_file', { path: '.env' }, result, 3)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.detail, 'masked')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summarizeToolResult counts the lines an edit added and removed', () => {
  const edited = summarizeToolResult(
    'edit_file',
    { path: 'src/a.ts', oldString: 'a\nb\nc', newString: 'a\nb\nc\nd\ne' },
    'ok',
    5,
  )
  assert.equal(edited.detail, '+5 −3 lines')

  const one = summarizeToolResult('edit_file', { oldString: 'x', newString: 'y' }, 'ok', 1)
  assert.equal(one.detail, '+1 −1 line')

  const written = summarizeToolResult('write_file', { content: 'a\nb' }, 'ok', 1)
  assert.equal(written.detail, '+2 lines')
})

test('summarizeToolResult counts matches, entries and exits', () => {
  const noHits = summarizeToolResult('search_content', { query: 'zzz' }, 'No matches found.', 2)
  assert.equal(noHits.detail, '0 matches')

  const twoHits = summarizeToolResult(
    'search_content',
    { query: 'x' },
    'src/a.ts:1: x\nsrc/b.ts:2: x\n(capped at 50 results)',
    2,
  )
  assert.equal(twoHits.detail, '2 matches')

  const listed = summarizeToolResult('list_files', {}, JSON.stringify([1, 2, 3]), 1)
  assert.equal(listed.detail, '3 entries')
  const listedOne = summarizeToolResult('list_files', {}, JSON.stringify([1]), 1)
  assert.equal(listedOne.detail, '1 entry')

  const okCmd = summarizeToolResult(
    'run_command',
    { command: 'pnpm test' },
    JSON.stringify({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    1400,
  )
  assert.equal(okCmd.ok, true)
  assert.equal(okCmd.detail, 'exit 0 · 1.4s')

  const badCmd = summarizeToolResult(
    'run_command',
    { command: 'pnpm test' },
    JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: 'boom' }),
    20,
  )
  assert.equal(badCmd.ok, false)
  assert.equal(badCmd.detail, 'exit 1 · 0.0s')

  // A baseline records the exit as the expected value, so a failure is not one.
  const baseline = summarizeToolResult(
    'run_baseline',
    { command: 'pnpm test' },
    JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: '' }),
    10,
  )
  assert.equal(baseline.ok, false)
  assert.equal(baseline.detail, 'exit 1 (expected)')
})

test('summarizeToolResult marks a tool error as failed and keeps the message short', () => {
  const denied = summarizeToolResult(
    'write_file',
    { path: '.env' },
    'Error: Access denied: .env is a masked file',
    1,
  )
  assert.equal(denied.ok, false)
  assert.match(denied.detail, /Access denied/)

  const malformed = summarizeToolResult('run_command', {}, 'not json', 1)
  assert.equal(malformed.ok, false)
  assert.equal(malformed.detail, 'malformed result')
})
