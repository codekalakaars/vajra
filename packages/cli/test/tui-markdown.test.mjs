import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/**
 * The TUI used to push assistant text through `renderMarkdown`, which emits ANSI
 * escape bytes. Ink does not interpret them and counts them when measuring
 * width, so styled lines wrapped and padded wrongly. These pin the replacement:
 * the structure is real, and a half-streamed answer degrades to literal text
 * rather than throwing or losing characters.
 */

const mdUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tui', 'session', 'markdown.js')).href
const { __parseBlocks, __parseSpans } = await import(mdUrl)

test('headings, rules and quotes are recognised as structure', () => {
  const blocks = __parseBlocks('## Heading\n\n> quoted line\n\n---\n')
  assert.deepEqual(
    blocks.map(b => b.kind),
    ['heading', 'quote', 'rule'],
  )
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[1].spans[0].text, 'quoted line')
})

test('bullets and ordered lists keep their nesting depth', () => {
  const blocks = __parseBlocks('- one\n- two\n  - nested\n\n1. first\n2. second\n')
  assert.equal(blocks[0].kind, 'list')
  assert.equal(blocks[0].ordered, false)
  assert.deepEqual(blocks[0].items.map(i => i.depth), [0, 0, 1])
  assert.deepEqual(blocks[0].items.map(i => i.spans[0].text), ['one', 'two', 'nested'])

  const ordered = __parseBlocks('1. first\n2. second\n')
  assert.equal(ordered[0].ordered, true)
})

test('fenced code keeps its language and its exact indentation', () => {
  const blocks = __parseBlocks('```ts\nconst x = 1\n  indented\n```\n')
  assert.equal(blocks[0].kind, 'code')
  assert.equal(blocks[0].lang, 'ts')
  assert.deepEqual(blocks[0].lines, ['const x = 1', '  indented'])
})

test('an unterminated fence still renders as code, because it is mid-stream', () => {
  const blocks = __parseBlocks('```js\nconst half = ')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'code')
  assert.deepEqual(blocks[0].lines, ['const half = '])
})

test('inline emphasis, code and links become spans', () => {
  const spans = __parseSpans('plain **bold** and *italic* and `code` and [docs](https://x.dev)')
  assert.deepEqual(spans.map(s => s.text), [
    'plain ', 'bold', ' and ', 'italic', ' and ', 'code', ' and ', 'docs (https://x.dev)',
  ])
  assert.equal(spans[1].bold, true)
  assert.equal(spans[3].italic, true)
  assert.equal(spans[5].code, true)
  // A link keeps its target visible rather than hiding it behind the label.
  assert.match(spans[7].text, /https:\/\/x\.dev/)
})

test('an unfinished marker stays literal instead of swallowing the rest', () => {
  const bold = __parseSpans('start **unclosed bold')
  assert.equal(bold.some(s => s.bold), false)
  assert.equal(bold.map(s => s.text).join(''), 'start **unclosed bold')

  const code = __parseSpans('call `fn( and more text')
  assert.equal(code.some(s => s.code), false)
  assert.equal(code.map(s => s.text).join(''), 'call `fn( and more text')
})

test('no markdown markers means the text survives unchanged', () => {
  for (const plain of [
    'just a sentence',
    'a path like packages/cli/src/run.ts',
    '100% of the time',
    'a < b and c > d',
    '',
  ]) {
    const blocks = __parseBlocks(plain)
    const rebuilt = blocks
      .map(b => (b.kind === 'paragraph' ? b.spans.map(s => s.text).join('') : ''))
      .join('')
    assert.equal(rebuilt, plain, `round-trip failed for ${JSON.stringify(plain)}`)
  }
})

test('CRLF input and blank-line separation both parse', () => {
  assert.equal(__parseBlocks('a\r\n\r\nb\r\n').filter(b => b.kind === 'paragraph').length, 2)
  assert.equal(__parseBlocks('a\n\n\n\nb').length, 2)
})

test('an empty answer produces no blocks, so nothing is rendered', () => {
  assert.deepEqual(__parseBlocks(''), [])
  assert.deepEqual(__parseBlocks('   \n  \n'), [])
})
