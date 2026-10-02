import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// Imported before the code under test: the OpenAI SDK captures the global fetch
// when it loads, so the trampoline has to be in place first.
import { recordingHandle, recordingUi, roundChunks, sseResponse, useProvider } from './_provider.mjs'

/**
 * K3 and K4, end to end through the Worker's own loop.
 *
 * The units are tested in `ladder-units.test.mjs`; what is left is the wiring —
 * whether the loop measures its own context, whether the checkpoint round is the
 * only round that ever offers `write_checkpoint`, whether stuck really ends the
 * attempt, and whether every exit path reports what it left behind. Those are the
 * parts a unit test cannot see and a bench run can only see once it is already
 * wrong.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const { executeTask } = await import(pathToFileURL(join(dist, 'tasks', 'execute.js')).href)
const { TODAYS_PARAMS } = await import(pathToFileURL(join(dist, 'bench', 'params.js')).href)

const MODEL = 'zen/ladder-test'

const TASK = {
  id: 't-ladder',
  title: 'Inspect the tree',
  description: null,
  instructions: ['read the files'],
  readFile: ['a.txt'],
  writeFile: ['a.txt'],
  deleteFile: [],
  createDir: [],
  validation: [],
  timeoutSeconds: 60,
  maxRetries: 0,
  rollback: [],
  skipIf: [],
}

const withParams = patch => ({ ...TODAYS_PARAMS, ...patch })

/** Answers a handle gives for the one file these tests use. */
const FILE = { 'a.txt': 'the contents\n' }
const FILE_ANSWERS = { read_file: FILE['a.txt'], list_files: '[]' }

/** Share low enough that anything with content in it crosses it. */
const CROSSED = 0.000001

const CHECKPOINT_ARGS = {
  decisions: [{ decision: 'read before writing', reason: 'the file is generated' }],
  done: ['read a.txt'],
  remaining: ['write it'],
  notes: 'the header is generated',
}

/**
 * A provider that answers a normal round from `script` and a checkpoint round
 * with `write_checkpoint`.
 *
 * The two are told apart by the tools on the wire, which is the whole point: a
 * checkpoint round offers exactly one tool and requires a call to it, and a round
 * that cannot tell them apart would let the Worker compact whenever it liked.
 */
function ladderProvider(script) {
  const requests = []
  let asked = 0
  const restore = useProvider(async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)
    const forced = body.tools?.length === 1 && body.tools[0].function.name === 'write_checkpoint'
    if (forced) {
      return sseResponse(
        roundChunks({ toolCalls: [{ name: 'write_checkpoint', args: CHECKPOINT_ARGS, id: 'checkpoint_1' }] }),
      )
    }
    // Ordinary rounds follow the script; the checkpoint round is not one of them,
    // so it must not advance it.
    const round = script[Math.min(script.length - 1, asked++)]
    return sseResponse(roundChunks(round ?? {}))
  })
  return { requests, restore }
}

/** One Worker attempt, with everything observed. */
async function runWorker(t, {
  task = TASK,
  params = TODAYS_PARAMS,
  script = [{ text: 'done' }],
  answers = {},
  files = { 'a.txt': 'the contents\n' },
  context,
} = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'vajra-ladder-'))
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  const provider = ladderProvider(script)
  t.after(() => provider.restore())
  const handle = recordingHandle(answers)
  const events = []
  const attempts = []
  const ok = await executeTask(
    'agent-ladder',
    task,
    handle,
    'sk-test',
    MODEL,
    recordingUi(),
    null,
    null,
    null,
    'session-ladder',
    null,
    projectDir,
    undefined,
    event => events.push(event),
    params,
    undefined,
    context
      ? { ...context, onAttemptEnd: record => attempts.push(record) }
      : { onAttemptEnd: record => attempts.push(record) },
  )
  return { ok, events, attempts, requests: provider.requests, calls: handle.calls }
}

const contexts = events => events.filter(event => event.type === 'context')

test('with every context switch off, no context event is emitted at all', async t => {
  const { events, requests } = await runWorker(t, {
    script: [{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: 'done' }],
  })
  assert.deepEqual(contexts(events), [])
  assert.match(requests[0].messages[0].content, /^You are a worker agent\. Follow the instructions EXACTLY/)
  assert.equal(requests[0].messages[1].content, 'Execute the task now.')
})

test('elision fires once the share passes elideAt, and says what it rewrote', async t => {
  const { events } = await runWorker(t, {
    params: withParams({ elision: true, elideAt: CROSSED, keepRecentRounds: 1, elidedTailLines: 5 }),
    // Round 1 reads, round 2 edits it (so the read is superseded), round 3 prose.
    script: [
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', oldString: 'contents', newString: 'new' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'b.txt', oldString: 'x', newString: 'y' } }] },
      { text: 'done' },
    ],
  })

  const elided = contexts(events).filter(event => event.kind === 'elided')
  assert.equal(elided.length, 1, 'the second round is the first one with something stale')
  assert.match(elided[0].detail, /1 stale tool result\(s\) rewritten/)
  assert.ok(elided[0].before > 0)
  // One round has passed by the next attempt at elision, so the count does not
  // climb every round once the share is passed.
  assert.equal(contexts(events).filter(event => event.kind === 'elided').length, 1)
})

test('a compaction replaces the conversation with system, task and the L1 block', async t => {
  const { events, requests } = await runWorker(t, {
    params: withParams({ checkpoints: true, compactAt: CROSSED, stuckCheckpointShare: 0.9 }),
    script: [
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'new\n' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', oldString: 'new', newString: 'newer' } }] },
      { text: 'done' },
    ],
  })

  const compacted = contexts(events).filter(event => event.kind === 'compacted')
  assert.ok(compacted.length >= 1)
  assert.match(compacted[0].detail, /token\(s\) kept/)

  // The forced round offers the checkpoint tool and nothing else, and no ordinary
  // round ever does.
  const forcedAt = requests.findIndex(
    body => body.tools?.length === 1 && body.tools[0].function.name === 'write_checkpoint',
  )
  assert.ok(forcedAt >= 0, 'a checkpoint round was made')
  assert.equal(requests[forcedAt].tool_choice, 'required')
  for (const body of requests) {
    const offers = (body.tools ?? []).map(tool => tool.function.name)
    if (offers.includes('write_checkpoint')) assert.equal(offers.length, 1)
  }
  // And the round after it starts from the compacted conversation.
  const after = requests[requests.indexOf(requests[forcedAt]) + 1]
  assert.deepEqual(after.messages.map(m => m.role), ['system', 'user', 'user'])
  assert.match(after.messages[2].content, /# Checkpoint/)
  assert.match(after.messages[2].content, /Files this attempt wrote: a\.txt/)
})

test('the checkpoint the runtime stores carries the ledger, not the model\'s account of it', async t => {
  const { attempts } = await runWorker(t, {
    params: withParams({ checkpoints: true, compactAt: CROSSED, stuckCheckpointShare: 0.9 }),
    script: [
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'new\n' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', oldString: 'new', newString: 'newer' } }] },
      { text: 'all done' },
    ],
  })

  const checkpoint = attempts[0].checkpoint
  assert.ok(checkpoint, 'the attempt left a checkpoint')
  assert.deepEqual(checkpoint.filesChanged, ['a.txt'])
  assert.deepEqual(checkpoint.decisions, CHECKPOINT_ARGS.decisions)
  assert.equal(checkpoint.notes, CHECKPOINT_ARGS.notes)
})

test('a checkpoint bigger than stuckCheckpointShare ends the attempt stuck', async t => {
  const { ok, attempts, events } = await runWorker(t, {
    params: withParams({
      checkpoints: true,
      compactAt: CROSSED,
      stuckCheckpointShare: CROSSED,
      maxCompactionsWithoutProgress: 9,
    }),
    script: [
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'new\n' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', oldString: 'new', newString: 'newer' } }] },
      { text: 'done' },
    ],
  })

  assert.equal(ok, false, 'a stuck attempt is a failed attempt')
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].outcome, 'stuck')
  assert.match(attempts[0].error, /checkpoint alone needs/)
  assert.equal(contexts(events).filter(event => event.kind === 'stuck').length, 1)
})

test('compactions with no progress end the attempt stuck', async t => {
  const { ok, attempts, events } = await runWorker(t, {
    params: withParams({
      checkpoints: true,
      compactAt: CROSSED,
      stuckCheckpointShare: 0.9,
      maxCompactionsWithoutProgress: 2,
    }),
    // Reads only: nothing is written and no command runs, so nothing progresses.
    script: [
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'b.txt' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'c.txt' } }] },
      { text: 'done' },
    ],
  })

  assert.equal(ok, false)
  assert.equal(attempts[0].outcome, 'stuck')
  assert.match(attempts[0].error, /2 compactions with no new file written/)
  assert.equal(contexts(events).filter(event => event.kind === 'compacted').length, 2)
})

test('a check that newly passes counts as progress, so the same command can compact repeatedly', async t => {
  let ran = 0
  const { ok, attempts } = await runWorker(t, {
    params: withParams({
      checkpoints: true,
      compactAt: CROSSED,
      stuckCheckpointShare: 0.9,
      maxCompactionsWithoutProgress: 2,
    }),
    script: [
      { toolCalls: [{ name: 'run_command', args: { command: 'pnpm test' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'pnpm test' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'pnpm test' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'pnpm test' } }] },
      { text: 'done' },
    ],
    // The first run fails and the second passes: the same command, newly green.
    answers: {
      run_command: () =>
        JSON.stringify({ exitCode: ran++ === 0 ? 1 : 0, signal: null, stdout: '', stderr: '' }),
    },
  })

  assert.equal(ok, true, 'four compactions with a check newly passing in between is progress')
  assert.notEqual(attempts[0].outcome, 'stuck')
})

test('every exit path reports what the attempt left behind', async t => {
  // done, with the Worker's own closing words.
  const done = await runWorker(t, { script: [{ text: 'changed run() to return a tuple' }] })
  assert.equal(done.ok, true)
  assert.equal(done.attempts[0].outcome, 'done')
  assert.equal(done.attempts[0].summary, 'changed run() to return a tuple')

  // failed_verification, with the command, its exit code and what it printed.
  const failed = await runWorker(t, {
    task: { ...TASK, validation: ['node --test'] },
    script: [{ text: 'thought I was done' }],
    answers: {
      run_command: JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: 'AssertionError: run is not a tuple' }),
    },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.attempts[0].outcome, 'failed_verification')
  assert.equal(failed.attempts[0].failure.command, 'node --test')
  assert.equal(failed.attempts[0].failure.exitCode, 1)
  assert.match(failed.attempts[0].failure.outputTail, /AssertionError/)
})

test('the files an attempt wrote come from the harness, in the order it wrote them', async t => {
  const { attempts } = await runWorker(t, {
    script: [
      { toolCalls: [{ name: 'write_file', args: { path: 'new.ts', content: 'x' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', oldString: 'contents', newString: 'new' } }] },
      { text: 'done' },
    ],
  })
  assert.deepEqual(attempts[0].filesWritten, ['new.ts', 'a.txt'])
})

test('with the pack on, the system message is the pack and the first message only says start', async t => {
  const { requests } = await runWorker(t, {
    params: withParams({ contextPack: true }),
    task: {
      ...TASK,
      context: [{ path: 'a.txt', reason: 'the edit site' }],
      edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }],
    },
    files: FILE,
    answers: FILE_ANSWERS,
  })

  const system = requests[0].messages[0].content
  assert.match(system, /^You are a worker agent\./)
  assert.match(system, /## 1\. Task/)
  assert.match(system, /## 4\. Edits/)
  assert.match(system, /the edit site/)
  assert.equal(requests[0].messages[1].content, 'Execute the task now.')
  assert.equal(requests[0].messages.length, 2)
})

test('the pack is announced as a context event with its size, hash and paths', async t => {
  const { events } = await runWorker(t, {
    params: withParams({ contextPack: true }),
    task: {
      ...TASK,
      context: [{ path: 'a.txt', reason: 'the edit site' }],
      edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }],
    },
    files: FILE,
    answers: FILE_ANSWERS,
  })

  const pack = contexts(events).find(event => event.kind === 'pack')
  assert.ok(pack)
  assert.match(pack.pack.hash, /^[0-9a-f]{64}$/)
  assert.ok(pack.pack.tokens > 0)
  assert.deepEqual(pack.pack.paths, ['a.txt'])
  assert.equal(pack.pack.stale, 0)
  assert.equal(pack.pack.omitted, 0)
})

test('a file the pack cannot read is named in it, and the attempt still runs', async t => {
  const { ok, requests, events } = await runWorker(t, {
    params: withParams({ contextPack: true }),
    task: {
      ...TASK,
      edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }],
    },
    files: FILE,
    answers: {
      read_file: () => {
        throw new Error('handle is gone')
      },
    },
  })

  // One unreadable file is named, not dropped: the Worker knows to go and read it.
  assert.match(requests[0].messages[0].content, /## 4\. Edits/)
  assert.match(requests[0].messages[0].content, /The file could not be read: handle is gone/)
  assert.ok(contexts(events).some(event => event.kind === 'pack'))
  assert.equal(ok, true)
})

test('respawnContext on: a retry is told what the last attempt did and why it failed', async t => {
  const previous = {
    attempt: 1,
    outcome: 'failed_verification',
    failure: { command: 'pnpm test', exitCode: 1, outputTail: 'expected run() to return a tuple' },
    filesWritten: ['src/a.ts'],
    diff: '--- src/a.ts\n+++ src/a.ts\n@@ -3,1 +3,1 @@\n-run\n+tuple',
    summary: 'made run return a tuple',
  }

  const packed = await runWorker(t, {
    params: withParams({ contextPack: true, respawnContext: true }),
    task: { ...TASK, edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }] },
    files: FILE,
    answers: FILE_ANSWERS,
    context: { previousAttempts: [previous] },
  })
  assert.match(packed.requests[0].messages[0].content, /## 3\. Previous attempt/)
  assert.match(packed.requests[0].messages[0].content, /pnpm test exited 1/)
  assert.match(packed.requests[0].messages[0].content, /attempt 1: failed_verification/)

  // With the pack off it goes in the first user message instead — the same block.
  const legacy = await runWorker(t, {
    params: withParams({ respawnContext: true }),
    task: { ...TASK, edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }] },
    files: FILE,
    answers: FILE_ANSWERS,
    context: { previousAttempts: [previous] },
  })
  assert.match(legacy.requests[0].messages[1].content, /^Execute the task now\.\n\nThis task has been attempted/)
  assert.match(legacy.requests[0].messages[1].content, /\+tuple/)
})

test('respawnContext off: the failed attempt is not passed on at all', async t => {
  const previous = {
    attempt: 1,
    outcome: 'failed_verification',
    failure: { command: 'pnpm test', exitCode: 1, outputTail: 'expected run() to return a tuple' },
    filesWritten: ['src/a.ts'],
  }
  const { requests } = await runWorker(t, {
    params: withParams({ contextPack: true }),
    task: { ...TASK, edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }] },
    files: FILE,
    answers: FILE_ANSWERS,
    context: { previousAttempts: [previous] },
  })

  const system = requests[0].messages[0].content
  assert.equal(system.includes('Previous attempt'), false)
  assert.equal(system.includes('pnpm test exited 1'), false)
})

test('a completed attempt never carries the failed conversation forward', async t => {
  const { requests } = await runWorker(t, {
    params: withParams({ contextPack: true, respawnContext: true, checkpoints: true, compactAt: 0.99 }),
    task: { ...TASK, edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }] },
    files: FILE,
    answers: FILE_ANSWERS,
    context: {
      previousAttempts: [
        {
          attempt: 1,
          outcome: 'stuck',
          error: 'its checkpoint alone needed 90000 tokens',
          filesWritten: ['src/a.ts'],
          checkpoint: {
            sequence: 1,
            filesChanged: ['src/a.ts'],
            decisions: [{ decision: 'split the file', reason: 'too big to hold' }],
            done: [],
            remaining: ['still the parser'],
          },
        },
      ],
    },
  })

  const previous = requests[0].messages[0].content
  assert.match(previous, /attempt 1: stuck/)
  assert.match(previous, /split the file/)
  assert.equal(previous.includes('read_file'), false, 'no tool output from the failed attempt')
})

test('upstream handoffs reach the pack of the task that depends on them', async t => {
  const { requests } = await runWorker(t, {
    params: withParams({ contextPack: true }),
    context: {
      upstream: {
        direct: [
          {
            taskId: 't0',
            title: 'Add the type',
            filesWritten: ['src/types.ts'],
            interfaces: ['export type Run'],
            summary: 'Run is a tuple now.',
          },
        ],
        transitive: [
          {
            taskId: 'tz',
            title: 'Older thing',
            filesWritten: ['src/z.ts'],
            interfaces: ['export function z'],
            summary: 'a story two steps away does not need',
          },
        ],
      },
    },
    task: { ...TASK, edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }] },
    files: { 'a.txt': 'the contents\n' },
  })

  const system = requests[0].messages[0].content
  assert.match(system, /## 7\. Upstream results/)
  assert.match(system, /Run is a tuple now\./)
  assert.match(system, /export type Run/)
  assert.match(system, /export function z/)
  assert.equal(system.includes('a story two steps away does not need'), false)
})

test('the project card and the plan\'s contracts both reach the pack', async t => {
  const { requests } = await runWorker(t, {
    params: withParams({ contextPack: true }),
    context: {
      projectCard: '- TypeScript (Node), pnpm\n- test: `node --test`',
      contracts: [
        { id: 'c1', statement: 'run returns a tuple.', producedBy: 't-ladder', consumedBy: [] },
        { id: 'c2', statement: 'Not ours.', producedBy: 'other', consumedBy: ['other'] },
      ],
    },
    task: { ...TASK, edits: [{ path: 'a.txt', op: 'modify', anchor: 'the contents', change: 'replace it' }] },
    files: { 'a.txt': 'the contents\n' },
  })

  const system = requests[0].messages[0].content
  assert.match(system, /## 9\. Project card/)
  assert.match(system, /node --test/)
  assert.match(system, /run returns a tuple\./)
  assert.equal(system.includes('Not ours.'), false)
})

test('the attempt that ends with the tool-call budget spent says so', async t => {
  const { ok, attempts } = await runWorker(t, {
    params: withParams({ workerMaxToolCalls: 1 }),
    script: [{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }],
  })
  assert.equal(ok, true, 'the attempt still completes; only the record is about the budget')
  assert.equal(attempts[0].outcome, 'budget')
})