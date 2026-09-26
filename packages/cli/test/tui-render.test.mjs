import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable, Readable } from 'node:stream'
import React from 'react'
import { render, Static, Text } from 'ink'
import { Transcript, TaskList } from '../dist/tui/session/components.js'

/**
 * Flicker is a performance property, so it is pinned here as one: settled
 * history must be written once, and the repainted region must stay bounded no
 * matter how long the session runs.
 */

function collector() {
  const out = new Writable({ write(_c, _e, cb) { cb() } })
  const stdin = new Readable({ read() {} })
  return { out, stdin }
}

const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '')

/**
 * Structural, not timing-based. Ink's own output is not observable from a test
 * (a byte-counting collector records nothing, so a "fewer bytes" assertion would
 * pass no matter what), and wall-clock assertions are flaky in CI. What actually
 * guarantees no flicker is that settled history is handed to `<Static>`, which
 * writes it once, instead of being rendered inside the repainted region.
 */
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

function countRenderedEntries(element) {
  // Entry text appears as a child Text; count the ones that are not under Static.
  let insideStatic = false
  let live = 0
  const walk = (node, inStatic) => {
    if (!node || typeof node !== 'object') return
    const isStatic = node.type === Static
    const next = inStatic || isStatic
    if (node.type === Text && !next && typeof node.props?.children === 'string') live++
    for (const child of React.Children.toArray(node.props?.children ?? [])) walk(child, next)
  }
  walk(element, insideStatic)
  return live
}

test('settled history is handed to <Static>, so it is written once', () => {
  const state = {
    entries: Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, kind: 'assistant', text: `message ${i}` })),
    streaming: 'tok',
    thinking: '',
    prompt: null,
    tasks: [],
    executionIndex: 0,
    executionTotal: 0,
    interrupted: false,
    finished: false,
    exitCode: 0,
  }
  const element = Transcript({ state })

  const stat = findStatic(element)
  assert.ok(stat, 'history must be rendered through <Static> or it is repainted forever')
  assert.equal(stat.props.items.length, 30, 'every committed entry belongs to the static region')
  assert.deepEqual(
    stat.props.items.map(e => e.seq),
    state.entries.map(e => e.seq),
  )
  // Only the live tail is repainted.
  assert.ok(
    countRenderedEntries(element) <= 2,
    'the repainted region must hold only the streaming tail',
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
      React.createElement(TaskList, { tasks, index: 1, total }),
      { stdout: sink, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 250))
    instance.unmount()
    const clean = strip(text)
    const drawn = (clean.match(/task \d+/g) || []).length
    assert.ok(drawn <= 10, `${running} running of ${total}: drew ${drawn} rows, expected at most 10`)
    assert.match(clean, /more tasks?/, 'the overflow must be reported, not silently dropped')
  }
  assert.ok(out)
})
