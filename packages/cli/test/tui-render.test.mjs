import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable, Readable } from 'node:stream'
import React from 'react'
import { render, Static, Text } from 'ink'
import {
  Transcript,
  TaskList,
  StatusBar,
  Sidebar,
  ChatInput,
  CommandPalette,
  SessionFrame,
} from '../dist/tui/session/components.js'
import { computeViewport } from '../dist/tui/session/viewport.js'
import { initialEditor } from '../dist/tui/session/editor.js'

/**
 * The session runs in the alternate screen buffer, where `<Static>` cannot
 * help: it writes above the frame, and in alt-screen there is no scrollback to
 * write into — anything that scrolls off the top is gone. History therefore
 * lives in a fixed-height, clipped viewport that renders a bounded slice, and
 * these tests pin that contract: no Static, a hard height, vertical clipping,
 * and a slice that never covers the whole transcript.
 */

function collector() {
  const out = new Writable({ write(_c, _e, cb) { cb() } })
  const stdin = new Readable({ read() {} })
  return { out, stdin }
}

const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '')

function findStatic(element) {
  if (!element || typeof element !== 'object') return null
  if (element.type === Static) return element
  const children = React.Children.toArray(element.props?.children ?? [])
  for (const child of children) {
    const found = findStatic(child)
    if (found) return found
  }
  return null
}

const baseState = entries => ({
  entries,
  streaming: '',
  thinking: '',
  prompt: null,
  tasks: [],
  executionIndex: 0,
  executionTotal: 0,
  interrupted: false,
  finished: false,
  exitCode: 0,
  tick: 0,
  usage: { promptTokens: 0, completionTokens: 0, calls: 0, lastPromptTokens: 0 },
})

test('history is a clipped fixed-height viewport, not <Static>', () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({
    seq: i + 1,
    kind: 'assistant',
    text: `message ${i}`,
  }))
  const viewport = computeViewport({ entries, width: 80, rows: 10, scroll: { mode: 'follow' } })
  const element = Transcript({ state: baseState(entries), viewport })

  assert.equal(findStatic(element), null, 'Static writes outside the frame — unusable in alt-screen')
  assert.equal(element.props.height, 10, 'the viewport owns a hard height')
  assert.equal(element.props.overflowY, 'hidden', 'content beyond the box must be clipped')
  assert.equal(
    element.props.justifyContent,
    'flex-end',
    'follow mode anchors the bottom so new output scrolls history off the top',
  )

  const sliceSize = viewport.end - viewport.start
  assert.ok(sliceSize < entries.length, 'only a slice is rendered, never the whole transcript')
  // One child per sliced entry plus the (empty) live-tail fragment.
  const children = React.Children.toArray(element.props.children)
  assert.equal(
    children.length,
    sliceSize + 1,
    `repainted ${children.length} nodes for a ${entries.length}-entry transcript`,
  )
})

test('follow mode keeps the newest entry on screen and cuts the oldest', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    seq: i + 1,
    kind: 'user',
    text: `line ${i}`,
  }))
  const viewport = computeViewport({ entries, width: 40, rows: 5, scroll: { mode: 'follow' } })
  assert.equal(viewport.end, entries.length, 'the newest entries are always rendered')
  assert.ok(viewport.start > 0, 'history longer than the viewport starts mid-transcript')
  assert.equal(viewport.atBottom, true)
})

test('scroll mode freezes an absolute top line, immune to new entries', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1,
    kind: 'user',
    text: `line ${i}`,
  }))
  const first = computeViewport({ entries, width: 40, rows: 6, scroll: { mode: 'scroll', topLine: 4 } })
  assert.equal(first.mode, 'scroll')
  assert.equal(first.topLine, 4, 'the anchor is the caller’s frozen line')
  // New entries append at the bottom; the frozen anchor must not move.
  const grown = entries.concat({ seq: 31, kind: 'user', text: 'line 30' })
  const second = computeViewport({ entries: grown, width: 40, rows: 6, scroll: { mode: 'scroll', topLine: 4 } })
  assert.equal(second.topLine, 4)
  assert.equal(second.start, first.start, 'the same content stays under the same anchor')
})

test('scrolling past the end falls back to follow mode', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    seq: i + 1,
    kind: 'user',
    text: `line ${i}`,
  }))
  const viewport = computeViewport({
    entries,
    width: 40,
    rows: 5,
    scroll: { mode: 'scroll', topLine: 999 },
  })
  assert.equal(viewport.mode, 'follow')
  assert.equal(viewport.atBottom, true)
})

test('the live tail is reserved out of the entry budget in follow mode', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({
    seq: i + 1,
    kind: 'user',
    text: `line ${i}`,
  }))
  const withoutLive = computeViewport({ entries, width: 40, rows: 10, scroll: { mode: 'follow' } })
  const withLive = computeViewport({
    entries,
    width: 40,
    rows: 10,
    scroll: { mode: 'follow' },
    liveRows: 4,
  })
  assert.ok(
    withLive.start > withoutLive.start,
    'a streaming tail must shrink the history slice, not overflow the frame',
  )
})

test('the task list stays bounded however large the plan is', async () => {
  const { out, stdin } = collector()
  for (const [running, total] of [[2, 30], [15, 30]]) {
    const tasks = Array.from({ length: total }, (_, i) => ({
      title: `task ${i}`,
      status: i < running ? 'running' : 'pending',
      activity: { tool: 'edit_file', summary: 'src/a.ts', since: Date.now(), toolCount: 2 },
    }))
    let text = ''
    const sink = new Writable({ write(c, _e, cb) { text += c.toString(); cb() } })
    const instance = render(
      React.createElement(TaskList, { tasks, index: 1, total, terminalRows: 24 }),
      { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 250))
    instance.unmount()
    const clean = strip(text)
    const drawn = (clean.match(/task \d+/g) || []).length
    assert.ok(drawn <= 8, `${running} running of ${total}: drew ${drawn} rows, expected at most 8`)
    assert.match(clean, /· \d+ more/, 'the overflow must be reported, not silently dropped')
  }
  assert.ok(out)
})

test('the bottom line is identity only, one row, within the width', async () => {
  const { stdin } = collector()
  const width = 80
  let text = ''
  const sink = new Writable({ write(c, _e, cb) { text += c.toString(); cb() } })
  sink.columns = width
  const instance = render(
    React.createElement(StatusBar, {
      version: '0.0.1',
      projectDir: '/mnt/drive/Repo/vajra/examples',
      width,
    }),
    { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 150))
  instance.unmount()
  const lines = strip(text).split('\n').filter(l => l.trim().length > 0)
  assert.equal(lines.length, 2, 'a rule and one identity line, never three')
  assert.match(lines[0], /^\s*\u2500/, 'the footer is ruled like OpenCode\u2019s')
  assert.match(lines[1], /^\s*\S/, 'the directory leads the line, indented inside the rule')
  const line = lines[1]
  assert.match(line, /v0\.0\.1/, 'the version identifies the build')
  assert.doesNotMatch(line, /Vajra/, 'the product name is not repeated on every frame')
  assert.doesNotMatch(line, /zen\//, 'the model is not repeated on the bar')
  assert.ok(line.trimEnd().endsWith('v0.0.1'), 'the version is the rightmost item')
  assert.doesNotMatch(line, /PgUp|history/, 'the scroll hint was removed from the bar')
  // Live state lives in the sidebar; it must not be duplicated on the bar.
  assert.doesNotMatch(line, /idle|working|ctx/)
  assert.ok(
    line.length <= width,
    `the bar must fit the terminal: ${line.length} cells for width ${width}`,
  )
})

test('the sidebar carries the live state, bounded by its height', async () => {
  const { stdin } = collector()
  const width = 30
  const height = 12
  let text = ''
  const sink = new Writable({ write(c, _e, cb) { text += c.toString(); cb() } })
  const instance = render(
    React.createElement(Sidebar, {
      state: {
        ...baseState([]),
        model: 'zen/space-bunny-free',
        projectDir: '/tmp',
        prompt: { id: 1, kind: 'user', label: 'You:', resolve() {} },
        tasks: Array.from({ length: 9 }, (_, i) => ({
          title: `a deliberately long task title number ${i}`,
          status: i < 2 ? 'running' : 'pending',
          activity: i < 2
            ? { tool: 'edit_file', summary: 'src/a/b/c.ts', since: Date.now(), toolCount: 3 }
            : undefined,
        })),
        usage: { promptTokens: 18400, completionTokens: 1200, calls: 7, lastPromptTokens: 9200 },
        executionIndex: 2,
        executionTotal: 9,
      },
      width,
      height,
      limit: 128000,
    }),
    { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 250))
  instance.unmount()
  const rows = strip(text).split('\n').filter(l => l.length > 0)

  assert.match(rows[0], /^│ ● idle/, 'status first')
  assert.doesNotMatch(rows[1], /ctx \d+%/, 'the context meter is gone: the prompt row owns it')
  const joined = rows.join('\n')
  assert.match(joined, /│ tasks \d+\/9 · \d+ more/, 'then the task count and the overflow')
  assert.match(joined, /◉/, 'and running tasks')
  assert.ok(rows.length <= height, `the sidebar must not outgrow the frame: ${rows.length} > ${height}`)
  for (const row of rows) {
    assert.ok(row.length <= width + 1, `row overflows the sidebar: ${JSON.stringify(row)}`)
  }
})

test('without a sidebar the bottom line carries the live state instead', async () => {
  const { stdin } = collector()
  const width = 80
  let text = ''
  const sink = new Writable({ write(c, _e, cb) { text += c.toString(); cb() } })
  sink.columns = width
  const instance = render(
    React.createElement(StatusBar, {
      version: '0.0.1',
      projectDir: '/mnt/drive/Repo/vajra',
      width,
      live: { icon: '\u25cf', color: 'gray', label: 'idle' },
    }),
    { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 150))
  instance.unmount()
  const lines = strip(text).split('\n').filter(l => l.trim().length > 0)
  assert.equal(lines.length, 2, 'the rule and the line, no more')
  assert.match(lines[1], /● idle/, 'the status is not lost without a sidebar')
  assert.doesNotMatch(lines[1], /ctx 42%/, 'the context meter is gone from the bar too')
  assert.ok(lines[1].trimEnd().endsWith('v0.0.1'), 'the version stays rightmost')
  assert.ok(lines[1].length <= width, `fits: ${lines[1].length}`)
})

test('a model that cannot reason says so, rather than offering a dead dial', async () => {
  const { stdin } = collector()
  let text = ''
  const sink = new Writable({ write(c, _e, cb) { text += c.toString(); cb() } })
  const instance = render(
    React.createElement(ChatInput, {
      prompt: { id: 1, kind: 'user', label: 'What would you like me to work on?', resolve() {} },
      editor: initialEditor(),
      model: 'zen/plain',
      effort: 'off',
      // One level: the catalog says this model has no reasoning vocabulary.
      levels: ['off'],
    }),
    { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 150))
  instance.unmount()
  const clean = strip(text)
  assert.match(clean, /reasoning n\/a/, 'ctrl-r that does nothing should not look like a dial')
  assert.doesNotMatch(clean, /reasoning off/, 'and it should not claim a level either')
})

test('the prompt is a placeholder inside the frame, and nothing else claims a row', async () => {
  const { stdin } = collector()
  let text = ''
  const sink = new Writable({ write(c, _e, cb) { text += c.toString(); cb() } })
  const instance = render(
    React.createElement(ChatInput, {
      prompt: { id: 1, kind: 'user', label: 'What would you like me to work on?', resolve() {} },
      editor: initialEditor(),
      model: 'space-bunny-free',
      effort: 'off',
      levels: ['off', 'low', 'medium', 'high'],
    }),
    { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 150))
  instance.unmount()
  const clean = strip(text)
  const rows = clean.split('\n').filter(l => l.length > 0)

  assert.equal(rows.length, 2, 'the input and the one status row under it — nothing else')
  assert.match(rows[0], /^\s{2}\u26a1 What would you like me to work on\?/, 'two cells in, the placeholder')
  assert.doesNotMatch(clean, /\u2502/, 'the input does not rule itself \u2014 the frame does')
  assert.match(rows[1], /^\s{2}space-bunny-free/, `the model leads the status row, aligned with the prompt: ${JSON.stringify(rows[1])}`)
  assert.match(rows[1], /reasoning off\s+ctrl\+r/, 'the reasoning dial is right-aligned on it')
  assert.doesNotMatch(clean, /ctx \d+%|\u2191|\u2193/, 'no context meter anywhere in the input')
  assert.doesNotMatch(clean, /Enter send|Esc clear|Type a task to start/, 'no key hints, ever')

  // Once you start typing, the prompt yields the row to your text.
  let typed = ''
  const sink2 = new Writable({ write(c, _e, cb) { typed += c.toString(); cb() } })
  const withText = render(
    React.createElement(ChatInput, {
      prompt: { id: 1, kind: 'user', label: 'What would you like me to work on?', resolve() {} },
      editor: { ...initialEditor(), value: 'fix the todos clobber' },
      model: 'space-bunny-free',
      effort: 'high',
      levels: ['off', 'low', 'medium', 'high'],
    }),
    { stdout: sink2, stdin: collector().stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 150))
  withText.unmount()
  const rows2 = strip(typed).split('\n').filter(l => l.length > 0)
  assert.equal(rows2.length, 2, 'still two rows: the text replaced the prompt')
  assert.match(rows2[0], /^\s{2}fix the todos/, 'the text keeps the placeholder\u2019s indent')
  assert.doesNotMatch(strip(typed), /What would you like me to work on/, 'the placeholder is gone once there is text')
  assert.match(strip(typed), /reasoning high/, 'and the row shows the chosen effort')
})

test('the frame rules the left edge of every row, once', async () => {
  const { stdin } = collector()
  let text = ''
  const sink = new Writable({ write(c, _e, cb) { text += c.toString(); cb() } })
  sink.columns = 60
  const instance = render(
    React.createElement(SessionFrame, { width: 57 },
      React.createElement(Text, null, 'first row'),
      React.createElement(Text, null, 'second row')),
    { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 150))
  instance.unmount()
  const rows = strip(text).split('\n').filter(l => l.length > 0)
  assert.equal(rows.length, 2, 'two rows, and the frame costs no extra row')
  for (const row of rows) {
    assert.match(row, /^\u2502/, `the rule is on every row: ${JSON.stringify(row)}`)
    assert.equal(row.match(/\u2502/g)?.length, 1, `ruled once: ${JSON.stringify(row)}`)
  }
  assert.doesNotMatch(rows[0], /\u250c|\u2510|\u2514|\u2518/, 'no top or bottom rule: the left only')
})

test('the slash palette lists matches with the first one highlighted', async () => {
  const { stdin } = collector()
  let text = ''
  const sink = new Writable({ write(c, _e, cb) { text += c.toString(); cb() } })
  const instance = render(
    React.createElement(CommandPalette, {
      matches: [
        { name: 'model', summary: 'Change the model' },
        { name: 'dir', summary: 'Change directory' },
      ],
      index: 1,
      width: 70,
    }),
    { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 150))
  instance.unmount()
  const rows = strip(text).split('\n').filter(l => l.length > 0)

  assert.equal(rows.length, 2, 'one row per match')
  // The box pads by two, so an unselected row reads `│` + pad + marker.
  assert.match(rows[0], /^│ {4}\/model/, 'unselected rows are not marked')
  assert.match(rows[1], /^│ {2}▸ \/dir/, 'the highlighted row carries the marker')
  assert.ok(rows.every(r => r.startsWith('│')), 'the palette shares the input\'s left rule')
})
