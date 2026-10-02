import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * K3, part 1: the pieces of the compaction ladder that have no model in them.
 *
 * Each is a small function with a large blast radius — a rewrite that drops a
 * tool result the Worker still needed, a diff that shows nothing, a ledger that
 * records what the model *said* rather than what the harness ran — so they are
 * tested directly, and the loop that assembles them is tested in
 * `attempt-ladder.test.mjs`.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const ledgerUrl = pathToFileURL(join(dist, 'tasks', 'ledger.js')).href
const elideUrl = pathToFileURL(join(dist, 'tasks', 'elide.js')).href
const diffUrl = pathToFileURL(join(dist, 'tasks', 'diff.js')).href
const checkpointUrl = pathToFileURL(join(dist, 'tasks', 'checkpoint.js')).href
const { WorkLedger } = await import(ledgerUrl)
const { elideMessages, pathsInSearchResult } = await import(elideUrl)
const { fileDiff, diffsWithin } = await import(diffUrl)
const {
  CHECKPOINT_TOOL,
  CHECKPOINT_TOOL_SPEC,
  compactedMessages,
  completeCheckpoint,
  madeProgress,
  markAt,
  parseCheckpoint,
  renderCheckpoint,
} = await import(checkpointUrl)

/** One recorded call, in the shape the loop hands the ledger. */
function call(over = {}) {
  return { round: 1, callId: 'c1', tool: 'read_file', args: { path: 'a.ts' }, content: 'body', ok: true, ...over }
}

const c1 = (exitCode, stdout = '', stderr = '') => JSON.stringify({ exitCode, signal: null, stdout, stderr })

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test('the ledger records what the harness ran, not what the model said', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ tool: 'read_file', args: { path: 'src/a.ts' } }))
  ledger.record(call({ callId: 'c2', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(1, '', 'failing') }))
  ledger.record(call({ callId: 'c3', tool: 'edit_file', args: { path: 'src/a.ts', oldString: 'x', newString: 'y' } }))

  const [read, command, edit] = ledger.all
  assert.deepEqual(read, { round: 1, tool: 'read_file', path: 'src/a.ts', mutated: false, ok: true })
  assert.deepEqual(command, { round: 1, tool: 'run_command', command: 'pnpm test', exitCode: 1, mutated: false, ok: true })
  assert.deepEqual(edit, { round: 1, tool: 'edit_file', path: 'src/a.ts', mutated: true, ok: true })
  assert.equal(ledger.filesWritten().join(','), 'src/a.ts')
  assert.deepEqual(ledger.lastVerification(), { command: 'pnpm test', exitCode: 1 })
  assert.deepEqual(ledger.commandSummary(), ['pnpm test → exit 1'])
})

test('a failed mutation is not a file written', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ tool: 'write_file', args: { path: 'a.ts' }, ok: false, content: 'Error: Access denied' }))
  assert.deepEqual(ledger.filesWritten(), [])
})

test('a command with argv records the argv, and one that is not JSON has no exit code', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ tool: 'run_command', args: { argv: ['node', '--test'] }, content: 'not json' }))
  assert.deepEqual(ledger.all[0], {
    round: 1,
    tool: 'run_command',
    command: 'node --test',
    exitCode: -1,
    mutated: false,
    ok: true,
  })
})

test('supersession asks whether something later touched the same path', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ callId: 'c1' }))
  assert.equal(ledger.supersededBy(ledger.forCall('c1')), false, 'nothing later yet')

  ledger.record(call({ callId: 'c2', tool: 'search_content', args: { query: 'x' } }))
  assert.equal(ledger.supersededBy(ledger.forCall('c1')), false, 'an unrelated call is not a supersession')

  ledger.record(call({ callId: 'c3', tool: 'edit_file', args: { path: 'a.ts' } }))
  assert.equal(ledger.supersededBy(ledger.forCall('c1')), true, 'an edit supersedes the read')
})

test('a re-read supersedes the read before it', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ callId: 'c1' }))
  ledger.record(call({ callId: 'c2' }))
  assert.equal(ledger.supersededBy(ledger.forCall('c1')), true)
  assert.equal(ledger.supersededBy(ledger.forCall('c2')), false, 'the newest read is the live one')
})

test('a command is only superseded by a later run of the same command', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ callId: 'c1', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(1) }))
  ledger.record(call({ callId: 'c2', tool: 'run_command', args: { command: 'pnpm build' }, content: c1(0) }))
  assert.equal(ledger.rerunAfter(ledger.forCall('c1')), false)
  ledger.record(call({ callId: 'c3', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(0) }))
  assert.equal(ledger.rerunAfter(ledger.forCall('c1')), true)
})

test('an unknown call id is not ours, and elision leaves it alone', () => {
  const ledger = new WorkLedger()
  assert.equal(ledger.forCall('nope'), undefined)
})

// ---------------------------------------------------------------------------
// Elision
// ---------------------------------------------------------------------------

/** A conversation of `rounds` rounds, each one read then edit. */
function conversation(rounds) {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }]
  for (let r = 0; r < rounds; r++) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_${r}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    })
    messages.push({ role: 'tool', content: `contents of ${r}`, tool_call_id: `call_${r}` })
  }
  return messages
}

test('a read nothing has superseded keeps its contents', () => {
  const ledger = new WorkLedger()
  const messages = conversation(4)
  ledger.record(call({ callId: 'call_0' }))
  const result = elideMessages(messages, ledger, { keepRecentRounds: 1, elidedTailLines: 5 })
  assert.equal(result.elided, 0)
  assert.deepEqual(result.messages, messages)
})

test('a read a later edit superseded becomes a note that says how to get it back', () => {
  const ledger = new WorkLedger()
  const messages = conversation(4)
  ledger.record(call({ callId: 'call_0' }))
  ledger.record(call({ callId: 'call_9', tool: 'edit_file', args: { path: 'a.ts' } }))
  const result = elideMessages(messages, ledger, { keepRecentRounds: 1, elidedTailLines: 5 })
  assert.equal(result.elided, 1)
  const rewritten = result.messages.find(m => m.tool_call_id === 'call_0')
  assert.match(rewritten.content, /\[elided\] a\.ts was read here/)
  assert.match(rewritten.content, /read_file\(\{ "path": "a\.ts" \}\)/)
})

test('the last keepRecentRounds rounds are never touched', () => {
  const ledger = new WorkLedger()
  const messages = conversation(4)
  for (const r of [0, 1, 2, 3]) ledger.record(call({ callId: `call_${r}` }))
  // Every read is superseded by the next, so all four would otherwise be elided.
  ledger.record(call({ callId: 'later', tool: 'edit_file', args: { path: 'a.ts' } }))
  const result = elideMessages(messages, ledger, { keepRecentRounds: 2, elidedTailLines: 5 })
  assert.equal(result.elided, 2, 'only the two oldest went')
  assert.equal(result.messages.at(-1).content, 'contents of 3')
  assert.equal(result.messages.at(-3).content, 'contents of 2')
})

test('a shorter conversation than keepRecentRounds is left entirely alone', () => {
  const ledger = new WorkLedger()
  const messages = conversation(2)
  for (const r of [0, 1]) ledger.record(call({ callId: `call_${r}` }))
  ledger.record(call({ callId: 'later', tool: 'edit_file', args: { path: 'a.ts' } }))
  assert.equal(elideMessages(messages, ledger, { keepRecentRounds: 3, elidedTailLines: 5 }).elided, 0)
})

test('an edit result becomes one line naming what was done', () => {
  const ledger = new WorkLedger()
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
    { role: 'tool', content: 'ok', tool_call_id: 'c1' },
  ]
  ledger.record(call({ callId: 'c1', tool: 'edit_file', args: { path: 'src/a.ts' } }))
  const result = elideMessages(messages, ledger, { keepRecentRounds: 0, elidedTailLines: 5 })
  assert.equal(result.messages.at(-1).content, 'ok: edited src/a.ts')
})

test('an older run of the same command keeps its exit code and the tail of its output', () => {
  const ledger = new WorkLedger()
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
    { role: 'tool', content: c1(1, Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')), tool_call_id: 'c1' },
  ]
  ledger.record(call({ callId: 'c1', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(1) }))
  ledger.record(call({ callId: 'c2', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(0) }))
  const result = elideMessages(messages, ledger, { keepRecentRounds: 0, elidedTailLines: 3 })
  const content = result.messages.at(-1).content
  assert.match(content, /exit 1/)
  assert.match(content, /line 39/)
  assert.doesNotMatch(content, /line 36/, 'only the last few lines are kept')
})

test('a command nothing re-ran keeps everything', () => {
  const ledger = new WorkLedger()
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
    { role: 'tool', content: c1(1, 'the one and only failure'), tool_call_id: 'c1' },
  ]
  ledger.record(call({ callId: 'c1', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(1) }))
  const result = elideMessages(messages, ledger, { keepRecentRounds: 0, elidedTailLines: 3 })
  assert.match(result.messages.at(-1).content, /the one and only failure/)
})

test('a search result becomes the paths it matched', () => {
  const ledger = new WorkLedger()
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_content', arguments: '{}' } }] },
    { role: 'tool', content: 'src/a.ts:12: const run = 1\nsrc/b.ts:3: run()', tool_call_id: 'c1' },
  ]
  ledger.record(call({ callId: 'c1', tool: 'search_content', args: { query: 'run' } }))
  const result = elideMessages(messages, ledger, { keepRecentRounds: 0, elidedTailLines: 3 })
  assert.equal(result.messages.at(-1).content, '[elided] search_content matched 2 path(s): src/a.ts, src/b.ts. Call it again to see the matches.')
})

test('a search with no matches keeps its answer, because "nothing found" is the answer', () => {
  const ledger = new WorkLedger()
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_content', arguments: '{}' } }] },
    { role: 'tool', content: 'No matches found.', tool_call_id: 'c1' },
  ]
  ledger.record(call({ callId: 'c1', tool: 'search_content', args: { query: 'zz' } }))
  const result = elideMessages(messages, ledger, { keepRecentRounds: 0, elidedTailLines: 3 })
  assert.equal(result.messages.at(-1).content, 'No matches found.')
})

test('both search shapes yield paths, and a shape neither recognises is left alone', () => {
  assert.deepEqual(pathsInSearchResult('search_content', 'a.ts:1: x\nb.ts:2: y'), ['a.ts', 'b.ts'])
  assert.deepEqual(pathsInSearchResult('search_files', 'src/a.ts [10L, 2 imports]\n  Symbols: run'), ['src/a.ts'])
  assert.deepEqual(pathsInSearchResult('search_content', 'something else entirely'), [])
})

test('elision never mutates the conversation it was given', () => {
  const ledger = new WorkLedger()
  const messages = conversation(2)
  ledger.record(call({ callId: 'call_0' }))
  ledger.record(call({ callId: 'later', tool: 'edit_file', args: { path: 'a.ts' } }))
  const before = JSON.stringify(messages)
  elideMessages(messages, ledger, { keepRecentRounds: 0, elidedTailLines: 5 })
  assert.equal(JSON.stringify(messages), before)
})

test('a result already elided is not counted again', () => {
  const ledger = new WorkLedger()
  const messages = conversation(3)
  ledger.record(call({ callId: 'call_0' }))
  ledger.record(call({ callId: 'later', tool: 'edit_file', args: { path: 'a.ts' } }))
  const options = { keepRecentRounds: 0, elidedTailLines: 5, alreadyElided: new Set(['call_0']) }
  assert.equal(elideMessages(messages, ledger, options).elided, 0)
})

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

test('a diff shows only the common-prefix and common-suffix stripped middle', () => {
  const diff = fileDiff({ path: 'a.ts', before: 'one\ntwo\nthree\nfour\nfive\n', after: 'one\ntwo\nTHREE\nfour\nfive\n' })
  assert.equal(diff, '--- a.ts\n+++ a.ts\n@@ -3,1 +3,1 @@\n-three\n+THREE')
})

test('a created file is all plus, a deleted file is all minus, and each says which', () => {
  const created = fileDiff({ path: 'new.ts', before: null, after: 'a\nb\n' })
  assert.match(created, /--- \/dev\/null/)
  assert.match(created, /\+\+\+ new\.ts \(new\)/)
  assert.equal(created, '--- /dev/null\n+++ new.ts (new)\n@@ -0,0 +1,2 @@\n+a\n+b')

  const deleted = fileDiff({ path: 'old.ts', before: 'a\n', after: null })
  assert.match(deleted, /\+\+\+ \/dev\/null \(deleted\)/)
  assert.equal(deleted, '--- old.ts\n+++ /dev/null (deleted)\n@@ -1,1 +0,0 @@\n-a')
})

test('an unchanged file has no diff at all', () => {
  assert.equal(fileDiff({ path: 'a.ts', before: 'same\n', after: 'same\n' }), '')
})

test('an inserted line at the top still yields a valid, non-overlapping hunk', () => {
  // Nothing common at the head, two lines common at the tail: one insertion, and
  // the hunk header says so rather than claiming a range that overlaps the suffix.
  const diff = fileDiff({ path: 'a.ts', before: 'b\nb\n', after: 'a\nb\nb\n' })
  assert.equal(diff, '--- a.ts\n+++ a.ts\n@@ -0,0 +1,1 @@\n+a')
})

test('several diffs share one budget and say which files did not fit', () => {
  const files = [
    { path: 'small.ts', before: 'a\n', after: 'b\n' },
    { path: 'large.ts', before: Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n'), after: 'X\n' },
    { path: 'later.ts', before: 'a\n', after: 'b\n' },
  ]
  const out = diffsWithin(files, 200)
  assert.match(out, /small\.ts/)
  assert.match(out, /later\.ts/, 'a small diff after a dropped one still fits')
  // 500 changed lines cannot fit in 200 characters, and saying which file was
  // dropped is what keeps a truncated diff from reading as a complete one.
  assert.match(out, /not shown: large\.ts/)
})

test('a diff that fits in full names no omissions', () => {
  const out = diffsWithin([{ path: 'a.ts', before: 'a\n', after: 'b\n' }], 10_000)
  assert.doesNotMatch(out, /not shown/)
  assert.doesNotMatch(out, /cut at/)
})

test('no changes at all is an empty diff, not an empty hunk', () => {
  assert.equal(diffsWithin([{ path: 'a.ts', before: 'x\n', after: 'x\n' }], 1000), '')
})

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

test('the checkpoint tool is offered only when the runtime asks for it', () => {
  assert.equal(CHECKPOINT_TOOL, 'write_checkpoint')
  assert.equal(CHECKPOINT_TOOL_SPEC.function.name, CHECKPOINT_TOOL)
  // Not in the Worker's ordinary tool list: a Worker may not compact whenever it
  // likes, or it will compact instead of working.
  assert.equal(JSON.stringify(CHECKPOINT_TOOL_SPEC).includes('edit_file'), false)
})

test('a malformed checkpoint loses only the model\'s half', () => {
  assert.deepEqual(parseCheckpoint(undefined), { decisions: [], done: [], remaining: [] })
  assert.deepEqual(parseCheckpoint({ decisions: 'nope', done: [1, ' x ', ''], remaining: {} }), {
    decisions: [],
    done: ['1', 'x'],
    remaining: [],
  })
  const parsed = parseCheckpoint({
    decisions: [{ decision: 'use a tuple', reason: 'so callers must destructure' }, { reason: 'no decision' }],
    done: ['wrote run'],
    remaining: ['test'],
    notes: '  the header is generated  ',
  })
  assert.deepEqual(parsed.decisions, [{ decision: 'use a tuple', reason: 'so callers must destructure' }])
  assert.equal(parsed.notes, 'the header is generated')
})

test('the runtime fills filesChanged and lastVerification, whatever the model said', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ tool: 'edit_file', args: { path: 'src/a.ts' } }))
  ledger.record(call({ callId: 'c2', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(1) }))
  const checkpoint = completeCheckpoint(
    { ...parseCheckpoint({ decisions: [], done: [], remaining: [], notes: 'x' }), filesChanged: ['src/lie.ts'] },
    1,
    ledger,
  )
  assert.deepEqual(checkpoint.filesChanged, ['src/a.ts'])
  assert.deepEqual(checkpoint.lastVerification, { command: 'pnpm test', exitCode: 1 })
  assert.equal(checkpoint.sequence, 1)
  assert.equal(checkpoint.notes, 'x')
})

test('the rendered checkpoint separates what the runtime knew from what the model said', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ tool: 'write_file', args: { path: 'src/a.ts' } }))
  const text = renderCheckpoint(
    completeCheckpoint(
      parseCheckpoint({
        decisions: [{ decision: 'use a tuple', reason: 'callers must destructure' }],
        done: ['wrote run'],
        remaining: ['run the suite'],
        notes: 'the header is generated',
      }),
      2,
      ledger,
    ),
  )
  assert.match(text, /Files changed \(recorded by the runtime\):\n {2}- src\/a\.ts/)
  assert.match(text, /Decisions:\n {2}- use a tuple — callers must destructure/)
  assert.match(text, /Remaining:\n {2}- run the suite/)
  assert.match(text, /compaction 2/)
})

test('the compacted conversation is system, task, then the L1 block', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ tool: 'write_file', args: { path: 'src/a.ts' } }))
  const checkpoint = completeCheckpoint(parseCheckpoint({ done: ['x'], remaining: ['y'] }), 1, ledger)
  const messages = compactedMessages({
    system: 'SYSTEM',
    taskMessage: 'Execute the task now.',
    checkpoint,
    ledger,
    diffs: [{ path: 'src/a.ts', before: 'a\n', after: 'b\n' }],
    diffChars: 6000,
  })

  assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'user'])
  assert.equal(messages[0].content, 'SYSTEM')
  assert.equal(messages[1].content, 'Execute the task now.')
  assert.match(messages[2].content, /# Checkpoint/)
  assert.match(messages[2].content, /# Runtime ledger/)
  assert.match(messages[2].content, /Files this attempt wrote: src\/a\.ts/)
  assert.match(messages[2].content, /# Changes so far/)
  assert.match(messages[2].content, /\n\+b/)
})

test('a checkpoint with nothing changed says so rather than showing an empty diff', () => {
  const messages = compactedMessages({
    system: 's',
    taskMessage: 't',
    checkpoint: completeCheckpoint(parseCheckpoint({ remaining: [] }), 1, new WorkLedger()),
    ledger: new WorkLedger(),
    diffs: [],
    diffChars: 6000,
  })
  assert.match(messages[2].content, /No tracked file has changed yet/)
})

test('progress is a new file written, or a check that newly passes', () => {
  const ledger = new WorkLedger()
  ledger.record(call({ callId: 'c1', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(1) }))
  const mark = markAt(ledger)
  assert.equal(madeProgress(mark, ledger), false, 'nothing has happened since the mark')

  ledger.record(call({ callId: 'c2', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(0) }))
  assert.equal(madeProgress(mark, ledger), true, 'the check that failed now passes')

  const other = new WorkLedger()
  other.record(call({ callId: 'd1', tool: 'run_command', args: { command: 'pnpm test' }, content: c1(1) }))
  const otherMark = markAt(other)
  other.record(call({ callId: 'd2', tool: 'edit_file', args: { path: 'new.ts' } }))
  assert.equal(madeProgress(otherMark, other), true, 'a file it had not written before')
})