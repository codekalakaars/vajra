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
