import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const streamingUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'streaming.js')).href
const { renderMarkdown, TerminalStreamer } = await import(streamingUrl)

test('renderMarkdown styles markdown', () => {
  process.env.FORCE_COLOR = '1'
  const out = renderMarkdown('# Title\n\n**bold** text\n\n- one\n- two\n')
  assert.match(out, /Title/)
  assert.match(out, /bold/)
  assert.match(out, /one/)
  assert.ok(out.endsWith('\n'))
})

test('renderMarkdown does not leave ** markers in list items', () => {
  process.env.FORCE_COLOR = '1'
  const out = renderMarkdown('- item **one** with *em* and `code`\n1. numbered **bold** step\n')
  assert.ok(!/\*\*one\*\*/.test(out), `still has **one**: ${JSON.stringify(out)}`)
  assert.ok(!/\*\*bold\*\*/.test(out), `still has **bold**: ${JSON.stringify(out)}`)
  assert.ok(!/\*em\*/.test(out), `still has *em*: ${JSON.stringify(out)}`)
  assert.match(out, /one/)
  assert.match(out, /bold/)
})

test('renderMarkdown styles strong/em outside lists', () => {
  process.env.FORCE_COLOR = '1'
  const out = renderMarkdown('Para **strong** and *emph* end.\n')
  assert.ok(!/\*\*strong\*\*/.test(out), JSON.stringify(out))
  assert.ok(!/\*emph\*/.test(out), JSON.stringify(out))
  assert.match(out, /strong/)
  assert.match(out, /emph/)
})

test('renderMarkdown falls back safely on empty input', () => {
  assert.equal(renderMarkdown(''), '')
  assert.equal(renderMarkdown('   \n'), '   \n')
})

test('renderMarkdown does not throw on malformed-ish markdown', () => {
  const out = renderMarkdown('```js\nunclosed fence\n**not closed')
  assert.ok(typeof out === 'string')
  assert.ok(out.length > 0)
})

test('TerminalStreamer buffers deltas and flushes rendered markdown on finishLine', () => {
  const chunks = []
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...args) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const streamer = new TerminalStreamer(false)
    streamer.onTextDelta('Hello **world**\n')
    streamer.onTextDelta('- a\n- b\n')
    // Nothing flushed yet
    assert.equal(chunks.length, 0)
    streamer.finishLine()
    assert.equal(chunks.length, 1)
    assert.match(chunks[0], /Hello/)
    assert.match(chunks[0], /world/)
    assert.match(chunks[0], /a/)
    // Buffer is empty after flush
    streamer.finishLine()
    assert.equal(chunks.length, 1)
  } finally {
    process.stdout.write = origWrite
    delete process.env.FORCE_COLOR
  }
})

test('TerminalStreamer.discardBuffer drops pending text', () => {
  const chunks = []
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...args) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const streamer = new TerminalStreamer(false)
    streamer.onTextDelta('should not print')
    streamer.discardBuffer()
    streamer.finishLine()
    assert.equal(chunks.length, 0)
  } finally {
    process.stdout.write = origWrite
  }
})

// --- sub-task activity (STREAMING_VISIBILITY.md) --------------------------
//
// Tests run with stdout not a TTY, which is exactly the piped/CI case: no
// spinner, no heartbeat, no control characters — one line per event.

function capture(fn) {
  const out = []
  const err = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk, ...rest) => {
    out.push(String(chunk))
    return true
  }
  process.stderr.write = (chunk, ...rest) => {
    err.push(String(chunk))
    return true
  }
  try {
    fn()
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return { out: out.join(''), err: err.join('') }
}

const DEV = { role: 'developer' }
const WORKER = { role: 'worker', taskId: 'auth-mw', title: 'Add auth middleware' }

test('a tool call prints a start line and a result line', () => {
  const { out, err } = capture(() => {
    const s = new TerminalStreamer(false)
    s.agentEvent({
      type: 'tool-start',
      agent: DEV,
      callId: 'c1',
      tool: 'read_file',
      summary: 'packages/cli/src/run.ts',
    })
    s.agentEvent({
      type: 'tool-end',
      agent: DEV,
      callId: 'c1',
      tool: 'read_file',
      ok: true,
      ms: 38,
      detail: '4.2 KB',
    })
  })
  assert.match(out, /→ read_file {2}packages\/cli\/src\/run\.ts/)
  assert.match(out, /← 4\.2 KB · 38ms/)
  // Piped output must be free of control characters.
  assert.ok(!/\x1b\[2K|\r/.test(out), `control characters leaked: ${JSON.stringify(out)}`)
  assert.equal(err, '')
})

test('piped output carries no escape sequences at all', () => {
  const { out, err } = capture(() => {
    const s = new TerminalStreamer(false)
    s.agentEvent({ type: 'phase', agent: DEV, phase: 'scanning' })
    s.agentEvent({ type: 'llm-start', agent: DEV, round: 1 })
    s.agentEvent({ type: 'heartbeat', agent: DEV, elapsedMs: 900 })
    s.agentEvent({
      type: 'tool-start',
      agent: { role: 'worker', taskId: 'auth-mw', title: 'Add auth middleware' },
      callId: 'c1',
      tool: 'run_command',
      summary: 'pnpm test',
    })
    s.agentEvent({
      type: 'tool-end',
      agent: { role: 'worker', taskId: 'auth-mw', title: 'Add auth middleware' },
      callId: 'c1',
      tool: 'run_command',
      ok: false,
      ms: 1400,
      detail: 'exit 1',
    })
    s.agentEvent({ type: 'llm-end', agent: DEV, round: 1, ms: 2400, budget: 60 })
  })
  // SGR colour is as much a control character as a spinner frame: a redirected
  // log or CI transcript must stay greppable.
  assert.ok(!out.includes('\x1b'), `escape sequences leaked: ${JSON.stringify(out)}`)
  assert.ok(!err.includes('\x1b'), `escape sequences leaked: ${JSON.stringify(err)}`)
  // …and the content is still all there.
  assert.match(out, /◇ developer · scanning/)
  assert.match(out, /\[auth-mw\] → run_command {2}pnpm test/)
  assert.match(out, /\[auth-mw\] ← exit 1 · 1400ms/)
})

test('every worker line names its task, so four of them stay attributable', () => {
  const { out } = capture(() => {
    const s = new TerminalStreamer(false)
    for (const [id, tool] of [
      ['auth-mw', 'edit_file'],
      ['db-seed', 'run_command'],
      ['docs', 'write_file'],
    ]) {
      s.agentEvent({
        type: 'tool-start',
        agent: { role: 'worker', taskId: id, title: id },
        callId: `c-${id}`,
        tool,
        summary: 'src/a.ts',
      })
      s.agentEvent({
        type: 'tool-end',
        agent: { role: 'worker', taskId: id, title: id },
        callId: `c-${id}`,
        tool,
        ok: true,
        ms: 10,
        detail: 'ok',
      })
    }
  })
  assert.match(out, /\[auth-mw\] → edit_file/)
  assert.match(out, /\[db-seed\] → run_command/)
  assert.match(out, /\[docs\] → write_file/)})

test('a failed tool call is marked as such', () => {
  const { out } = capture(() => {
    const s = new TerminalStreamer(false)
    s.agentEvent({
      type: 'tool-end',
      agent: DEV,
      callId: 'c1',
      tool: 'run_command',
      ok: false,
      ms: 5,
      detail: 'exit 1 · 0.0s',
    })
  })
  assert.match(out, /exit 1/)
})

test('phases are reported once, and heartbeats print nothing when piped', () => {
  const { out, err } = capture(() => {
    const s = new TerminalStreamer(false)
    s.agentEvent({ type: 'phase', agent: DEV, phase: 'indexing' })
    s.agentEvent({ type: 'llm-start', agent: DEV, round: 1 })
    s.agentEvent({ type: 'heartbeat', agent: DEV, elapsedMs: 900 })
    s.agentEvent({ type: 'llm-end', agent: DEV, round: 1, ms: 1200, budget: 60 })
  })
  assert.match(out, /◇ developer · indexing/)
  // A 1.2s provider call must not print start/heartbeat spam into a log —
  // exactly one line for the completed round.
  assert.ok(!/thinking/.test(out))
  assert.equal(out.match(/◇ developer · 1\.2s/g)?.length ?? 0, 1)
  assert.match(out, /round 1\/60/)
  assert.equal(err, '', 'no status line outside a TTY')
})

test('--quiet restores task-level-only output', () => {
  const { out, err } = capture(() => {
    const s = new TerminalStreamer(false, undefined, true)
    s.agentEvent({ type: 'phase', agent: DEV, phase: 'indexing' })
    s.agentEvent({
      type: 'tool-start',
      agent: DEV,
      callId: 'c1',
      tool: 'read_file',
      summary: 'a.ts',
    })
    s.agentEvent({
      type: 'tool-end',
      agent: DEV,
      callId: 'c1',
      tool: 'read_file',
      ok: true,
      ms: 3,
      detail: '1.0 KB',
    })
    s.agentEvent({ type: 'heartbeat', agent: DEV, elapsedMs: 10 })
  })
  assert.equal(out, '')
  assert.equal(err, '')
})
