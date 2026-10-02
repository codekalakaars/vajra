import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'

// Imported before the code under test: the OpenAI SDK captures the global fetch
// when it loads, so the trampoline has to be in place first.
import {
  recordingHandle,
  recordingUi,
  roundChunks,
  scriptedProvider,
  sseResponse,
  useProvider,
} from './_provider.mjs'

const dist = join(import.meta.dirname, '..', 'dist')
const executeUrl = pathToFileURL(join(dist, 'worker', 'execute.js')).href
const serverUrl = pathToFileURL(join(dist, 'worker', 'server.js')).href
const paramsUrl = pathToFileURL(join(dist, 'bench', 'params.js')).href
const catalogUrl = pathToFileURL(join(dist, 'model', 'catalog.js')).href
const { parseCommandResult, executeTask } = await import(executeUrl)
const { allocateServerPort, probeServerPort, substituteServerPort } = await import(serverUrl)
const { TODAYS_PARAMS } = await import(paramsUrl)
const { parseCatalog, resetCatalog, loadModelCatalog } = await import(catalogUrl)

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

// ---------------------------------------------------------------------------
// The Worker's knobs — bench/config.json's workerMaxToolCalls, workerReasoning,
// taskTimeoutSec and preloadReads, one test each.
//
// Every test here runs the Worker loop itself rather than a helper it exposes,
// because a knob is only honest if it is visible on the wire or in the tool
// calls: a test that called a private function would pass just as happily if the
// knob were never read.
// ---------------------------------------------------------------------------

/** Today's values with the keys under test named. */
const withParams = patch => ({ ...TODAYS_PARAMS, ...patch })

const TASK = {
  id: 't-knob',
  title: 'Inspect the tree',
  description: null,
  instructions: ['read the files'],
  readFile: [],
  writeFile: [],
  deleteFile: [],
  createDir: [],
  validation: [],
  timeoutSeconds: 60,
  maxRetries: 0,
  rollback: [],
  skipIf: [],
}

function tempProject(prefix, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content, 'utf-8')
  }
  return dir
}

/**
 * A provider that keeps every request body it was handed.
 *
 * `scriptedProvider` throws the bodies away, and the reasoning knob is only
 * observable on the wire: `chat.ts` drops a level the model does not accept, so
 * asserting on what the loop passed in would not catch a filter that was never
 * applied.
 */
function capturingProvider(script) {
  const requests = []
  const restore = useProvider(async (_url, init) => {
    requests.push(JSON.parse(init.body))
    const round = script[Math.min(requests.length - 1, script.length - 1)] ?? {}
    return sseResponse(roundChunks(round))
  })
  return { requests, restore }
}

/** One Worker attempt, with the ports the loop needs stubbed. */
async function runWorker(t, {
  task = TASK,
  params = TODAYS_PARAMS,
  model = 'zen/test-model',
  script = [{}],
  files = {},
  answers = {},
} = {}) {
  const projectDir = tempProject('vajra-knob-', files)
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  const provider = capturingProvider(script)
  t.after(() => provider.restore())
  const handle = recordingHandle(answers)
  const ui = recordingUi()
  const events = []
  const ok = await executeTask(
    'agent-knob',
    task,
    handle,
    'sk-test',
    model,
    ui,
    null, // changeHistory
    null, // queue
    null, // registry
    'session-knob',
    null, // fileLocks
    projectDir,
    undefined, // signal
    event => events.push(event),
    params,
  )
  return { ok, requests: provider.requests, calls: handle.calls, ui, events }
}

test('workerMaxToolCalls is where the loop stops asking the model', async t => {
  // A model that never stops asking: the last round repeats, so the only thing
  // that can end the loop is the budget.
  const script = [{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: '1' } }] }]
  for (const [budget, expected] of [[1, 1], [2, 2]]) {
    const { ok, calls } = await runWorker(t, {
      params: withParams({ workerMaxToolCalls: budget }),
      script,
      task: { ...TASK, writeFile: ['a.txt'] },
    })
    assert.equal(ok, true, `budget ${budget} should still complete`)
    assert.equal(calls.length, expected, `budget ${budget} ran ${calls.length} calls`)
    assert.ok(calls.every(call => call.tool === 'write_file'), 'the calls that ran are the ones asked for')
  }
})

test('workerReasoning goes on the wire for a model with that level, and nowhere else', async t => {
  // A catalog read from a cache file rather than the network: the filter is
  // exactly a question about what the model accepts, so the test needs models
  // that answer differently.
  const dir = mkdtempSync(join(tmpdir(), 'vajra-catalog-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    resetCatalog()
  })
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      catalog: parseCatalog({
        opencode: {
          api: 'https://opencode.ai/zen/v1',
          models: {
            reasoner: {
              id: 'reasoner',
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
            },
            plain: { id: 'plain', reasoning: false },
          },
        },
      }),
    }),
  )
  resetCatalog()
  await loadModelCatalog({
    env: { VAJRA_HOME: dir },
    now: Date.now(),
    fetchImpl: async () => {
      throw new Error('a primed catalog must not refetch')
    },
  })

  const reasoningOn = await runWorker(t, {
    model: 'zen/reasoner',
    params: withParams({ workerReasoning: 'high' }),
  })
  assert.equal(reasoningOn.requests[0].reasoning_effort, 'high')

  const noReasoning = await runWorker(t, {
    model: 'zen/plain',
    params: withParams({ workerReasoning: 'high' }),
  })
  assert.equal('reasoning_effort' in noReasoning.requests[0], false)
  assert.equal('reasoning' in noReasoning.requests[0], false)

  // 'off' is the shipped config, and it says nothing on the wire at all.
  const off = await runWorker(t, { model: 'zen/reasoner', params: TODAYS_PARAMS })
  assert.equal('reasoning_effort' in off.requests[0], false)
  assert.equal('reasoning' in off.requests[0], false)
})

/** A provider that takes `delayMs` to answer, the way a slow round does. */
function slowProvider(delayMs, round = {}) {
  return useProvider(async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    return sseResponse(roundChunks(round))
  })
}

test('taskTimeoutSec ends an attempt that has run out, and the attempt fails', async t => {
  // Slow rounds, and a model that always wants another: the deadline has to end
  // the attempt on its own, because nothing else here would.
  const projectDir = tempProject('vajra-timeout-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  t.after(
    slowProvider(400, { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: '1' } }] }),
  )

  const ui = recordingUi()
  const started = Date.now()
  const ok = await executeTask(
    'agent-timeout',
    { ...TASK, writeFile: ['a.txt'] },
    recordingHandle(),
    'sk-test',
    'zen/test-model',
    ui,
    null,
    null,
    null,
    'session-timeout',
    null,
    projectDir,
    undefined,
    undefined,
    withParams({ taskTimeoutSec: 1 }),
  )
  const elapsed = Date.now() - started

  assert.equal(ok, false, 'a timed-out attempt is a failure, so the Manager may retry it')
  assert.ok(elapsed < 3000, `took ${elapsed}ms — the deadline did not end the attempt`)
  assert.deepEqual(ui.calls.filter(call => call[0] === 'error'), [], 'a timeout is not an unexplained error')
  assert.match(
    ui.calls.filter(call => call[0] === 'warning').map(call => call[1]).join('\n'),
    /timed out after 1s/,
  )
})

test('taskTimeoutSec is a ceiling, not a clock: a fast attempt still succeeds', async t => {
  const projectDir = tempProject('vajra-in-time-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  t.after(slowProvider(0, { text: 'done' }))

  const ok = await executeTask(
    'agent-in-time',
    TASK,
    recordingHandle(),
    'sk-test',
    'zen/test-model',
    recordingUi(),
    null,
    null,
    null,
    'session-in-time',
    null,
    projectDir,
    undefined,
    undefined,
    withParams({ taskTimeoutSec: 60 }),
  )
  assert.equal(ok, true)
})

test('a validation command may not outlive the attempt it belongs to', async t => {
  const projectDir = tempProject('vajra-validation-ceiling-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  // A slow round leaves less than the task's own 60s of validation time, so the
  // attempt's deadline — not the task field — is what the command is given.
  t.after(slowProvider(1200, { text: 'done' }))
  const handle = recordingHandle({
    run_command: JSON.stringify({ exitCode: 0, signal: null, stdout: 'ok', stderr: '' }),
  })

  const ok = await executeTask(
    'agent-validation',
    { ...TASK, validation: ['node --test'], timeoutSeconds: 60 },
    handle,
    'sk-test',
    'zen/test-model',
    recordingUi(),
    null,
    null,
    null,
    'session-validation',
    null,
    projectDir,
    undefined,
    undefined,
    withParams({ taskTimeoutSec: 2 }),
  )

  assert.equal(ok, true)
  const command = handle.calls.find(call => call.tool === 'run_command')
  assert.ok(command, 'validation ran')
  assert.ok(command.args.timeoutMs > 0, 'a command is never handed a timeout that means "none"')
  assert.ok(command.args.timeoutMs < 60_000, `validation was still allowed ${command.args.timeoutMs}ms`)
})

test('preloadReads hands the read files over in the first message, and drops the read rule', async t => {
  const task = { ...TASK, readFile: ['a.txt'] }
  const answers = { read_file: 'the contents of a\n' }

  const preloaded = await runWorker(t, {
    task,
    params: withParams({ preloadReads: true }),
    files: { 'a.txt': 'the contents of a\n' },
    answers,
  })
  const firstMessage = preloaded.requests[0].messages[1]
  assert.equal(firstMessage.role, 'user')
  assert.match(firstMessage.content, /the contents of a/)
  assert.match(firstMessage.content, /a\.txt/, 'the file is named, not just quoted')
  const systemPrompt = preloaded.requests[0].messages[0].content
  assert.doesNotMatch(systemPrompt, /Read each readFile first/, 'the contents are already in the message')
  assert.deepEqual(
    preloaded.calls.map(call => call.tool),
    ['read_file'],
    'the one read is the preload — the model asked for none',
  )

  // The shipped config leaves both the message and the rule exactly as they were.
  const today = await runWorker(t, { task, files: { 'a.txt': 'the contents of a\n' }, answers })
  assert.equal(today.requests[0].messages[1].content, 'Execute the task now.')
  assert.match(today.requests[0].messages[0].content, /Read each readFile first/)
  assert.deepEqual(today.calls, [], 'the Worker is told to read the file itself')
})

test('preloadReads names a file it could not read, rather than dropping it', async t => {
  const { requests, ui } = await runWorker(t, {
    task: { ...TASK, readFile: ['gone.txt'] },
    params: withParams({ preloadReads: true }),
    answers: {
      read_file: () => {
        throw new Error('Access denied: gone.txt')
      },
    },
  })
  const firstMessage = requests[0].messages[1]
  assert.match(firstMessage.content, /gone\.txt/)
  assert.match(firstMessage.content, /Access denied/, 'the Worker is told why it has no contents')
  assert.match(
    ui.calls.filter(call => call[0] === 'warning').map(call => call[1]).join('\n'),
    /Could not preload gone\.txt/,
  )
})

test('the session signal still ends an attempt the way it always did', async t => {
  // Combining the two signals must not turn the session's abort into a timeout:
  // an interrupted attempt leaves the loop and reports what it always reported.
  const projectDir = tempProject('vajra-interrupt-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  const controller = new AbortController()
  controller.abort()
  const ui = recordingUi()
  const provider = scriptedProvider([{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: '1' } }] }])
  t.after(() => provider.restore())

  const ok = await executeTask(
    'agent-interrupt',
    { ...TASK, writeFile: ['a.txt'] },
    recordingHandle(),
    'sk-test',
    'zen/test-model',
    ui,
    null,
    null,
    null,
    'session-interrupt',
    null,
    projectDir,
    controller.signal,
    undefined,
    TODAYS_PARAMS,
  )
  assert.equal(ok, true)
  assert.deepEqual(ui.calls.filter(call => call[0] === 'warning'), [])
})

// ---------------------------------------------------------------------------
// Pausing: the scheduler shuts a Worker's gate while the CPU is saturated.
// ---------------------------------------------------------------------------

const { PauseGate } = await import(pathToFileURL(join(dist, 'manager', 'pause.js')).href)

test('a paused Worker asks the model nothing, and its pause does not run down its deadline', async t => {
  const projectDir = tempProject('vajra-paused-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  const roundsAt = []
  t.after(
    useProvider(async () => {
      roundsAt.push(Date.now())
      return sseResponse(roundChunks({ text: 'done' }))
    }),
  )

  const gate = new PauseGate()
  gate.pause()
  const resumedAt = { at: 0 }
  setTimeout(() => {
    resumedAt.at = Date.now()
    gate.resume()
  }, 1500)

  const ui = recordingUi()
  const ok = await executeTask(
    'agent-paused',
    TASK,
    recordingHandle(),
    'sk-test',
    'zen/test-model',
    ui,
    null,
    null,
    null,
    'session-paused',
    null,
    projectDir,
    undefined,
    undefined,
    // Shorter than the pause: had the clock run while paused, this would fail.
    withParams({ taskTimeoutSec: 1 }),
    gate,
  )

  assert.equal(ok, true, 'the attempt had its whole second once resumed')
  assert.equal(roundsAt.length, 1)
  assert.ok(roundsAt[0] >= resumedAt.at, 'no model round while paused')
  assert.doesNotMatch(ui.calls.map(call => String(call[1])).join('\n'), /timed out/)
})

test('a session interrupt reaches a paused Worker', async t => {
  const projectDir = tempProject('vajra-paused-abort-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  t.after(useProvider(async () => sseResponse(roundChunks({ text: 'done' }))))

  const gate = new PauseGate()
  gate.pause()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const started = Date.now()
  await executeTask(
    'agent-paused-abort',
    TASK,
    recordingHandle(),
    'sk-test',
    'zen/test-model',
    recordingUi(),
    null,
    null,
    null,
    'session-paused-abort',
    null,
    projectDir,
    controller.signal,
    undefined,
    withParams({}),
    gate,
  )
  assert.ok(Date.now() - started < 2000, 'the attempt ended instead of waiting on the gate')
})

// ---------------------------------------------------------------------------
// Context: the Worker caps what it keeps and trims what it sends.
// ---------------------------------------------------------------------------

test('a tool result over toolOutputMaxChars reaches the model capped', async t => {
  const script = [
    { toolCalls: [{ name: 'read_file', args: { path: 'big.txt' } }] },
    { text: 'done' },
  ]
  const { requests } = await runWorker(t, {
    params: withParams({ toolOutputMaxChars: 1000 }),
    script,
    task: { ...TASK, readFile: ['big.txt'] },
    answers: { read_file: 'z'.repeat(50_000) },
  })
  const toolMessage = requests[1].messages.find(m => m.role === 'tool')
  assert.ok(toolMessage.content.length < 1200, `kept ${toolMessage.content.length} characters`)
  assert.match(toolMessage.content, /showing the first 1,000 of 50,000 characters/)
})

test('a Worker whose history outgrows the window drops its oldest exchanges, never its task', async t => {
  // A model with a 12k-token window, so a few 8k-character reads overflow it.
  const dir = mkdtempSync(join(tmpdir(), 'vajra-tiny-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    resetCatalog()
  })
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      catalog: parseCatalog({
        opencode: {
          api: 'https://opencode.ai/zen/v1',
          models: { tiny: { id: 'tiny', limit: { context: 12_000 } } },
        },
      }),
    }),
  )
  resetCatalog()
  await loadModelCatalog({
    env: { VAJRA_HOME: dir },
    now: Date.now(),
    fetchImpl: async () => {
      throw new Error('a primed catalog must not refetch')
    },
  })

  const read = i => ({ toolCalls: [{ name: 'read_file', args: { path: `f${i}.txt` }, id: `call_${i}` }] })
  const script = [read(1), read(2), read(3), read(4), read(5), { text: 'done' }]
  const { ok, requests, events } = await runWorker(t, {
    model: 'zen/tiny',
    script,
    answers: { read_file: 'q'.repeat(8000) },
  })

  assert.equal(ok, true)
  const last = requests.at(-1).messages
  assert.equal(last[0].role, 'system')
  assert.match(last[1].content, /Execute the task now/)
  const chars = last.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
  assert.ok(chars < 12_000 * 4, `sent ${chars} characters to a 12k-token window`)
  assert.ok(requests.at(-1).messages.length < 2 + 5 * 2, 'older exchanges were dropped')
  assert.ok(events.some(e => e.type === 'warning' && /Context trimmed/.test(e.text)))
})

test('a tool call whose arguments are not valid JSON is answered with why, and the tool is not run', async t => {
  // Content full of backticks and quotes is where a model's JSON breaks. Before,
  // the tool ran on `undefined` and the model was told "reading 'path'", so it
  // concluded the content was the problem and began working around backticks.
  const broken = '{"path": "a.js", "content": "const s = `x` + \'y\' + "unescaped"}'
  const script = [
    { toolCalls: [{ name: 'write_file', rawArgs: broken }] },
    { text: 'done' },
  ]
  const { requests, calls } = await runWorker(t, {
    script,
    task: { ...TASK, writeFile: ['a.js'] },
  })
  assert.deepEqual(calls.filter(c => c.tool === 'write_file'), [], 'the tool was never called')
  const answer = requests[1].messages.find(m => m.role === 'tool').content
  assert.match(answer, /not valid JSON/)
  assert.match(answer, /nothing was run/)
  assert.match(answer, /Backticks and single quotes need no escaping/)
  assert.doesNotMatch(answer, /reading 'path'/)
})
