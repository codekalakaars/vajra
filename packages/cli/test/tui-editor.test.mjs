import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const editorUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tui', 'session', 'editor.js')).href
const { editorReducer, initialEditor, editorSplits, editorRenderRows, HISTORY_LIMIT } =
  await import(editorUrl)

const run = (state, ...actions) => actions.reduce(editorReducer, state)
const typed = text => ({ type: 'insert', text })

test('typing inserts at the cursor and backspace deletes before it', () => {
  let s = run(initialEditor(), typed('hello'))
  assert.equal(s.value, 'hello')
  assert.equal(s.cursor, 5)
  s = run(s, { type: 'left' }, { type: 'left' }, { type: 'backspace' })
  assert.equal(s.value, 'helo', 'backspace removes the char before the cursor')
  assert.equal(s.cursor, 2)
  s = run(s, { type: 'delete' })
  assert.equal(s.value, 'heo', 'delete removes the char under the cursor')
})

test('word motion jumps over whole words', () => {
  const s = run(initialEditor(), typed('foo bar baz'), { type: 'word-left' })
  assert.equal(s.cursor, 8, 'lands at the start of "baz"')
  const back = run(s, { type: 'word-left' })
  assert.equal(back.cursor, 4, 'lands at the start of "bar"')
  const fwd = run(back, { type: 'word-right' })
  assert.equal(fwd.cursor, 7, 'lands at the end of "bar"')
})

test('history walks back and restores the draft on the way forward', () => {
  let s = initialEditor()
  s = run(s, { type: 'push-history', text: 'first task' })
  s = run(s, { type: 'push-history', text: 'second task' })
  assert.deepEqual(s.history, ['first task', 'second task'])
  assert.equal(s.value, '', 'pushing clears the editor')

  s = run(s, { type: 'history-prev' })
  assert.equal(s.value, 'second task')
  s = run(s, { type: 'history-prev' })
  assert.equal(s.value, 'first task')
  s = run(s, { type: 'history-prev' })
  assert.equal(s.value, 'first task', 'clamped at the oldest entry')

  s = run(s, { type: 'history-next' })
  assert.equal(s.value, 'second task')
  s = run(s, { type: 'history-next' })
  assert.equal(s.value, '', 'the draft comes back past the newest entry')
})

test('a repeated submission is not duplicated in history', () => {
  let s = run(initialEditor(), { type: 'push-history', text: 'same' })
  s = run(s, { type: 'push-history', text: 'same' })
  assert.deepEqual(s.history, ['same'])
})

test('history is capped', () => {
  let s = initialEditor()
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
    s = run(s, { type: 'push-history', text: `task ${i}` })
  }
  assert.equal(s.history.length, HISTORY_LIMIT)
  assert.equal(s.history[0], 'task 10', 'the oldest entries fall off the front')
})

test('blank submissions never enter history', () => {
  const s = run(initialEditor(), { type: 'push-history', text: '   ' })
  assert.deepEqual(s.history, [])
})

test('multiline drafts move the cursor by line, keeping the column', () => {
  let s = run(initialEditor(), typed('hello world\nhi\nlonger line'))
  // Cursor at the very end (line 3, col 11).
  s = run(s, { type: 'line-up' })
  assert.equal(s.value.slice(0, s.cursor), 'hello world\nhi', 'one line up, column clamped to the line')
  s = run(s, { type: 'line-up' })
  assert.equal(s.cursor, 2, 'column 2 carried up from "hi"')
  s = run(s, { type: 'line-down' }, { type: 'line-down' })
  assert.equal(s.cursor, 17, 'column 2 of the last line')
  s = run(s, { type: 'line-end' })
  assert.equal(s.cursor, s.value.length, 'end of the last line')
  // On the first line, line-up is a no-op (the caller falls back to history).
  const atTop = run(s, { type: 'line-start' }, { type: 'line-up' }, { type: 'line-up' })
  assert.equal(atTop.cursor, 0)
})

test('line-start and line-end work within the current line', () => {
  let s = run(initialEditor(), typed('abc\ndef'), { type: 'left' }, { type: 'left' })
  assert.equal(s.value.slice(0, s.cursor), 'abc\nd')
  s = run(s, { type: 'line-start' })
  assert.equal(s.cursor, 4, 'start of "def"')
  s = run(s, { type: 'line-end' })
  assert.equal(s.cursor, 7, 'end of "def"')
})

test('splits put the cursor cell between before and after', () => {
  const mid = run(initialEditor(), typed('abc'), { type: 'left' })
  assert.deepEqual(editorSplits(mid), { before: 'ab', at: 'c', after: '' })
  const end = run(initialEditor(), typed('abc'))
  assert.deepEqual(editorSplits(end), { before: 'abc', at: '', after: '' })
  const empty = editorSplits(initialEditor())
  assert.deepEqual(empty, { before: '', at: '', after: '' })
})

test('render rows account for wrapping and the inline label', () => {
  assert.equal(editorRenderRows('', 40), 1, 'an empty draft is one row')
  assert.equal(editorRenderRows('x'.repeat(40), 40), 1)
  assert.equal(editorRenderRows('x'.repeat(41), 40), 2, 'a long line wraps')
  assert.equal(
    editorRenderRows('x'.repeat(40), 40, 'You: '),
    2,
    'the label shares the first row, so it wraps sooner',
  )
  assert.equal(editorRenderRows('a\nb', 40), 2, 'every logical line is a row')
})
