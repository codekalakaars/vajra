import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * K4: what a finished task hands on, and what a retry is told about the attempt
 * it is replacing.
 *
 * Both records are mostly runtime-owned, and that is the point being pinned down
 * here. A handoff whose file list came from the model would be a summary, and a
 * summary of which files were written is wrong the moment the model is wrong. So
 * the paths and the interfaces are computed from the files themselves, and only
 * the sentence is the model's.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const handoffUrl = pathToFileURL(join(dist, 'tasks', 'handoff.js')).href
const { buildHandoff, changedDeclarations, declarationsOf, renderPreviousAttempts } = await import(handoffUrl)

const BEFORE = `export function run() {
  return 1
}

function helper() {
  return 2
}
`

const AFTER = `export function run() {
  return [1]
}

function helper() {
  return 2
}

export class Runner {}
`

function handoffOf(over = {}) {
  return buildHandoff({
    taskId: 't1',
    title: 'Make run return a tuple',
    filesWritten: ['src/a.ts'],
    before: new Map([['src/a.ts', BEFORE]]),
    after: new Map([['src/a.ts', AFTER]]),
    summary: 'run now returns a tuple, so callers must destructure it.',
    maxSummaryChars: 800,
    ...over,
  })
}

test('a handoff names the files from the ledger, not from the model', () => {
  const handoff = handoffOf()
  assert.deepEqual(handoff.filesWritten, ['src/a.ts'])
  assert.equal(handoff.taskId, 't1')
  assert.equal(handoff.title, 'Make run return a tuple')
})

test('interfaces are the declarations a change added or altered', () => {
  const handoff = handoffOf()
  // `run` is the same declaration line in both, so it is not an interface change.
  assert.deepEqual(handoff.interfaces, ['src/a.ts: export class Runner {}'])
})

test('a declaration that is gone is reported as removed, because a caller needs to know', () => {
  // `run` and `helper` are the same declaration lines in both, so the only thing
  // that changed about this file's interface is the class that appeared.
  assert.deepEqual(changedDeclarations(BEFORE, AFTER), ['export class Runner {}'])
  assert.deepEqual(changedDeclarations(AFTER, BEFORE), ['(removed) export class Runner {}'])
})

test('a created file is all new declarations, a deleted file is all removed', () => {
  const created = buildHandoff({
    taskId: 't2',
    title: 'Add the module',
    filesWritten: ['src/new.ts'],
    before: new Map([['src/new.ts', null]]),
    after: new Map([['src/new.ts', 'export function go() {}\n']]),
    summary: '',
    maxSummaryChars: 800,
  })
  assert.deepEqual(created.interfaces, ['src/new.ts: export function go() {}'])

  const deleted = buildHandoff({
    taskId: 't3',
    title: 'Remove the module',
    filesWritten: ['src/old.ts'],
    before: new Map([['src/old.ts', 'export function gone() {}\n']]),
    after: new Map([['src/old.ts', null]]),
    summary: '',
    maxSummaryChars: 800,
  })
  assert.deepEqual(deleted.interfaces, ['src/old.ts: (removed) export function gone() {}'])
})

test('a file with no baseline is named in filesWritten and skipped in interfaces', () => {
  const handoff = buildHandoff({
    taskId: 't4',
    title: 'Write it',
    filesWritten: ['src/new.ts'],
    before: new Map(),
    after: new Map([['src/new.ts', 'export function go() {}\n']]),
    summary: '',
    maxSummaryChars: 800,
  })
  assert.deepEqual(handoff.filesWritten, ['src/new.ts'])
  assert.deepEqual(handoff.interfaces, [], 'no baseline means no honest comparison')
})

test("the model's summary is capped, and says it was cut", () => {
  const handoff = handoffOf({ summary: 'x'.repeat(50), maxSummaryChars: 10 })
  assert.equal(handoff.summary, `${'x'.repeat(10)}…`)
})

test('declarations are top-level and trimmed; two identical lines count once', () => {
  // The second `export function a() {}` is a different line of text, so it is a
  // declaration too — what the file has, not what it means.
  assert.deepEqual(declarationsOf('export function a() {\n  const x = 1\n}\nexport function a() {}\n'), [
    'export function a() {',
    'export function a() {}',
  ])
  assert.deepEqual(declarationsOf('export function a() {}\nexport function a() {}\n'), [
    'export function a() {}',
  ])
  assert.deepEqual(declarationsOf(null), [])
})

test('a retry is told the outcome, the failure, one line per attempt and the diff', () => {
  const text = renderPreviousAttempts(
    [
      {
        attempt: 1,
        outcome: 'error',
        error: 'the sandbox died',
        filesWritten: [],
      },
      {
        attempt: 2,
        outcome: 'failed_verification',
        failure: { command: 'pnpm test', exitCode: 1, outputTail: 'expected a tuple, got a number' },
        filesWritten: ['src/a.ts'],
        diff: '--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,1 @@\n-return 1\n+return [1]',
        summary: 'made run return a tuple',
      },
    ],
    8000,
  )

  assert.match(text, /attempted 2 time\(s\) before/)
  assert.match(text, /- attempt 1: error/)
  assert.match(text, /- attempt 2: failed_verification \(pnpm test exited 1\), wrote src\/a\.ts/)
  assert.match(text, /The last attempt ended: failed_verification/)
  assert.match(text, /It failed pnpm test with exit 1/)
  assert.match(text, /The end of what that printed:\nexpected a tuple, got a number/)
  assert.match(text, /\+return \[1\]/)
  // The rollback means the diff is evidence about the approach, not code on disk.
  assert.match(text, /were rolled back/)
})

test('a stuck attempt says so in its own words rather than pretending it failed a check', () => {
  const text = renderPreviousAttempts([{ attempt: 1, outcome: 'stuck', filesWritten: [] }], 8000)
  assert.match(text, /ran out of room to keep its own state/)
  assert.match(text, /The last attempt ended: stuck/)
})

test("the last attempt's checkpoint is carried in full", () => {
  const text = renderPreviousAttempts(
    [
      {
        attempt: 1,
        outcome: 'stuck',
        filesWritten: ['src/a.ts'],
        checkpoint: {
          sequence: 1,
          filesChanged: ['src/a.ts'],
          decisions: [{ decision: 'split the file', reason: 'too big to hold whole' }],
          done: ['wrote the parser'],
          remaining: ['still the serialiser'],
          notes: 'the header is generated',
        },
      },
    ],
    8000,
  )
  assert.match(text, /# Checkpoint/)
  assert.match(text, /split the file — too big to hold whole/)
  assert.match(text, /still the serialiser/)
  assert.match(text, /the header is generated/)
})

test('the diff is capped, and a capped one is still labelled', () => {
  const text = renderPreviousAttempts(
    [{ attempt: 1, outcome: 'error', error: 'x', filesWritten: [], diff: 'y'.repeat(500) }],
    100,
  )
  assert.ok(text.includes('y'.repeat(100)))
  assert.equal(text.includes('y'.repeat(101)), false)
})

test('no earlier attempt means no block at all', () => {
  assert.equal(renderPreviousAttempts([], 8000), '')
})