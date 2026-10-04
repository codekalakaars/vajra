import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// Static imports are hoisted, so this module — and the global fetch trampoline
// it installs — is evaluated before the dynamic import of the code under test.
import { stubProvider, useProvider, sseResponse, toolFinish, textChunk, stopChunk } from './_provider.mjs'

/**
 * A turn spent entirely on tool calls used to print nothing at all. These drive
 * developerConversationTurn against a stubbed provider and assert the progress
 * events actually reach the caller — the mechanism existing is not evidence the
 * caller passes it (that is the 1C regression).
 */

const developerUrl = pathToFileURL(
  join(import.meta.dirname, '..', 'dist', 'developer', 'developer.js'),
).href

// The OpenAI SDK resolves the global fetch when it loads, so the stub has to be
// in place before developer.js is imported. _provider.mjs installs the
// trampoline at its own load time, which happens first.
const { developerConversationTurn, createEvidenceLedger, resetEvidenceLedger } = await import(developerUrl)

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-developer-'))
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  return dir
}

async function runTurn(overrides = {}) {
  // A caller running several turns of ONE conversation must pin projectDir: the
  // baseline key includes the resolved project path, so evidence collected
  // against one temp dir will not match a lookup made from another.
  const shared = overrides.projectDir
  const dir = shared ?? makeProject()
  const events = []
  let prose = 0
  try {
    const result = await developerConversationTurn({
      sessionId: 's1',
      projectDir: dir,
      userMessage: 'do the thing',
      model: 'zen/test',
      apiKey: 'k',
      // read_file answers with the project fixture; run_baseline answers with a
      // C1 payload that exits non-zero, which is what a proves-change check has
      // to observe before the change exists.
      handle: {
        callTool: async tool =>
          tool === 'run_baseline'
            ? JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: '' })
            : '# demo\n',
      },
      messages: [],
      summaryIndex: [],
      onTextDelta: () => { prose++ },
      onAgentEvent: e => events.push(e),
      ...overrides,
    })
    return { result, events, prose }
  } finally {
    if (!shared) rmSync(dir, { recursive: true, force: true })
  }
}

test('a turn that only calls tools still reports progress, start to finish', async () => {
  stubProvider()
  const { result, events, prose } = await runTurn()

  assert.equal(result.type, 'response')
  // Exactly one delta, and it belongs to round 2: the tool round said nothing,
  // which is precisely the silence this feature exists to remove.
  assert.equal(prose, 1)

  assert.deepEqual(events.map(e => e.type), [
    'phase', // indexing: the first turn builds the project context
    'phase', // planning
    'llm-start',
    'llm-end',
    'tool-start',
    'tool-end',
    'llm-start',
    'llm-end',
  ])
})

test('every tool-start is closed by exactly one tool-end', async () => {
  stubProvider()
  const { events } = await runTurn()

  const starts = events.filter(e => e.type === 'tool-start')
  const ends = events.filter(e => e.type === 'tool-end')
  // A dangling start leaves a renderer showing that tool as outstanding forever.
  assert.equal(starts.length, 1)
  assert.equal(ends.length, 1)
  assert.equal(starts[0].callId, ends[0].callId)

  assert.equal(starts[0].agent.role, 'developer')
  assert.equal(starts[0].tool, 'read_file')
  assert.equal(starts[0].summary, 'README.md')
  assert.equal(ends[0].ok, true)
  assert.equal(typeof ends[0].ms, 'number')
})

test('rounds carry their number and the loop budget', async () => {
  stubProvider()
  const { events } = await runTurn()

  const starts = events.filter(e => e.type === 'llm-start')
  const ends = events.filter(e => e.type === 'llm-end')
  assert.deepEqual(starts.map(e => e.round), [1, 2])
  assert.deepEqual(ends.map(e => e.round), [1, 2])
  assert.ok(ends.every(e => typeof e.ms === 'number' && e.ms >= 0))
  assert.ok(ends.every(e => typeof e.budget === 'number' && e.budget > 0))
})

test('a tool the harness rejects is still reported as a completed event', async () => {
  stubProvider('definitely_not_a_tool')
  const { events } = await runTurn()

  const start = events.find(e => e.type === 'tool-start')
  const end = events.find(e => e.type === 'tool-end')
  assert.ok(start, 'the attempt must still be announced')
  assert.ok(end, 'and must still be finished')
  assert.equal(end.ok, false)
})

test('the event stream is observability only — the turn result is unchanged', async () => {
  stubProvider()
  const quiet = await runTurn({ onAgentEvent: () => {} })
  assert.equal(quiet.result.type, 'response')
  assert.equal(quiet.result.response, 'done')
})

const { planShape, MAX_PLAN_TASKS } = await import(developerUrl)

test('a plan is one shape or the other, never a mix', () => {
  const structured = {
    title: 'structured task',
    context: [{ path: 'a.ts', reason: 'why' }],
    edits: [{ op: 'modify', path: 'a.ts', anchor: 'x', change: 'y' }],
    verify: [{ command: 'node', args: ['--test'], kind: 'proves-change' }],
  }
  const flat = {
    title: 'flat task',
    instructions: ['do the thing'],
    readFile: ['a.ts'],
    writeFile: ['a.ts'],
  }

  assert.equal(planShape([structured]).kind, 'structured')
  assert.equal(planShape([structured, { ...structured, title: 'other' }]).kind, 'structured')
  assert.equal(planShape([flat]).kind, 'flat')
  assert.equal(planShape([structured, flat]).kind, 'mixed')
  assert.match(planShape([structured, flat]).offenders, /structured task/)
  assert.match(planShape([structured, flat]).offenders, /flat task/)
  assert.equal(planShape([{ title: 'nothing' }]).kind, 'empty')
})

/**
 * Stub the provider to run `prelude` tool calls, then propose `tasks`, then
 * speak. The prelude is how a plan earns its evidence: read_file populates the
 * files actually opened, run_baseline the exit codes observed before any edit.
 */
function stubPlanProposal(tasks, prelude = []) {
  const requests = []
  let round = 0
  const steps = [...prelude, { name: 'propose_plan', args: { summary: 's', tasks } }]
  useProvider(async (_url, init) => {
    requests.push(JSON.parse(init.body))
    const step = steps[round++]
    if (step) {
      const chunk = {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_${step.name}_${round}`,
              type: 'function',
              function: { name: step.name, arguments: JSON.stringify(step.args) },
            }],
          },
          finish_reason: null,
        }],
      }
      return sseResponse([chunk, toolFinish])
    }
    return sseResponse([textChunk('done'), stopChunk])
  })
  return requests
}

/** A structured task that passes validation against the runTurn fixture. */
function validStructuredTask(overrides = {}) {
  return {
    id: 'demo',
    title: 'Extend the README heading',
    description: 'why it matters',
    type: 'modify',
    dependsOn: [],
    context: [{ path: 'README.md', reason: 'the heading this changes' }],
    edits: [{ op: 'modify', path: 'README.md', anchor: '# demo', change: 'name the project' }],
    verify: [{ command: 'node', args: ['--check', 'README.md'], kind: 'proves-change' }],
    ...overrides,
  }
}

/** The evidence a structured plan needs before it can be accepted. */
const VALIDATION_PRELUDE = [
  { name: 'read_file', args: { path: 'README.md' } },
  { name: 'run_baseline', args: { command: 'node', args: ['--check', 'README.md'] } },
]

/** Every tool result the model was given across all rounds, concatenated. */
function feedbackSeenBy(requests) {
  return requests
    .slice(1)
    .flatMap(r => r.messages ?? [])
    .filter(m => m.role === 'tool')
    .map(m => String(m.content))
    .join('\n')
}

test('a plan mixing task shapes is rejected, naming both kinds', async () => {
  const requests = stubPlanProposal([
    {
      id: 'a',
      title: 'structured one',
      description: 'why it matters',
      type: 'modify',
      context: [{ path: 'README.md', reason: 'see it' }],
      edits: [{ op: 'modify', path: 'README.md', anchor: '# demo', change: 'add' }],
      verify: [{ command: 'node', args: ['--check'], kind: 'proves-change' }],
    },
    {
      id: 'b',
      title: 'flat one',
      description: 'why it matters',
      type: 'modify',
      instructions: ['edit README.md'],
      readFile: ['README.md'],
      writeFile: ['README.md'],
    },
  ])

  const { result } = await runTurn()
  assert.equal(result.type, 'response', 'the plan was not accepted, so the turn continued')

  const feedback = feedbackSeenBy(requests)
  assert.match(feedback, /two different shapes/i)
  assert.match(feedback, /structured one/)
  assert.match(feedback, /flat one/)
})

test('an oversized plan is rejected with the limit and a way out', async () => {
  const many = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => ({
    id: `t${i}`,
    title: `task ${i}`,
    description: 'why it matters',
    type: 'modify',
    instructions: [`do ${i}`],
    readFile: ['README.md'],
    writeFile: ['README.md'],
  }))
  const requests = stubPlanProposal(many)

  await runTurn()
  const feedback = feedbackSeenBy(requests)
  assert.match(feedback, new RegExp(String(MAX_PLAN_TASKS)))
  assert.match(feedback, /consolidate/i)
})

test('rejections escalate: the third one tells the model to change approach', async () => {
  // A structured task citing a file that was never read is rejected every
  // time, which is exactly the loop a stuck model falls into.
  const requests = []
  let round = 0
  useProvider(async (_url, init) => {
    requests.push(JSON.parse(init.body))
    if (++round <= 3) {
      const chunk = {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_plan_${round}`,
              type: 'function',
              function: {
                name: 'propose_plan',
                arguments: JSON.stringify({
                  summary: 's',
                  tasks: [{
                    id: 'a',
                    title: 'never-read file',
                    description: 'why it matters',
                    type: 'modify',
                    context: [{ path: 'never-read.ts', reason: 'needed' }],
                    edits: [{ op: 'modify', path: 'never-read.ts', anchor: 'x', change: 'y' }],
                    verify: [{ command: 'node', args: ['--check'], kind: 'proves-change' }],
                  }],
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      }
      return sseResponse([chunk, toolFinish])
    }
    return sseResponse([textChunk('done'), stopChunk])
  })

  await runTurn()
  const feedback = feedbackSeenBy(requests)
  assert.match(feedback, /Plan rejected:/, 'the first rejection is plain')
  assert.match(feedback, /attempt 2/, 'the second says it is the second')
  assert.match(feedback, /attempt 3/, 'and the third is counted')
  assert.match(feedback, /change approach/i, 'and tells it to stop tweaking')
})

test('a plan that declares no verifiable shape is rejected, not accepted unchecked', async () => {
  // The legacy flat shape declares no target files and no success criteria, so
  // nothing about it can be checked. It used to be accepted with a warning
  // buried in the tool result, which is not evidence anyone acted on.
  const requests = stubPlanProposal([
    {
      id: 'a',
      title: 'flat one',
      description: 'why it matters',
      type: 'modify',
      instructions: ['do it'],
      readFile: ['README.md'],
      writeFile: ['README.md'],
    },
  ])

  const { result } = await runTurn()
  assert.equal(result.type, 'response', 'the plan was not accepted, so the turn continued')

  const feedback = feedbackSeenBy(requests)
  assert.match(feedback, /context\/edits\/verify/, 'names the shape it must use')
  assert.match(feedback, /no target files and no success criteria/, 'says why it is unusable')
})

test('a plan whose tasks are empty is rejected', async () => {
  // id/title/description alone: nothing to execute against, nothing to verify.
  const requests = stubPlanProposal([
    { id: 'a', title: 'do something', description: 'why it matters', type: 'modify' },
  ])

  const { result } = await runTurn()
  assert.equal(result.type, 'response')

  const feedback = feedbackSeenBy(requests)
  assert.match(feedback, /no target files and no success criteria/)
})

test('a circular dependsOn is rejected rather than silently unwound', async () => {
  // Two tasks each waiting on the other can never become ready. This used to be
  // accepted and then rewritten to dependsOn: [], which discarded the ordering
  // the model actually meant and ran the pair concurrently anyway.
  const requests = stubPlanProposal(
    [
      validStructuredTask({ id: 'a', dependsOn: ['b'] }),
      validStructuredTask({
        id: 'b',
        dependsOn: ['a'],
        edits: [{ op: 'create', path: 'b.md', change: 'new file' }],
        verify: [{ command: 'node', args: ['--check', 'b.md'], kind: 'proves-change' }],
      }),
    ],
    VALIDATION_PRELUDE.concat([
      { name: 'run_baseline', args: { command: 'node', args: ['--check', 'b.md'] } },
    ]),
  )

  const { result } = await runTurn()
  assert.equal(result.type, 'response', 'a cyclic plan was not accepted')

  const feedback = feedbackSeenBy(requests)
  assert.match(feedback, /Circular dependsOn/, 'the cause is named, not just "rejected"')
  assert.match(feedback, /'a'/)
  assert.match(feedback, /'b'/)
})

test('a valid structured plan is accepted', async () => {
  // The accept path for context/edits/verify had no coverage at all: every plan
  // test was either a rejection or a legacy flat accept.
  stubPlanProposal([validStructuredTask()], VALIDATION_PRELUDE)

  // Accepting ends the turn, so the acknowledgement is read off the
  // conversation the caller handed in rather than off another request.
  const messages = []
  const { result } = await runTurn({ messages })

  assert.equal(result.type, 'plan', 'a fully evidenced structured plan must be accepted')
  assert.equal(result.plan.tasks.length, 1)
  assert.equal(result.plan.tasks[0].id, 'demo')
  // The flat fields are lowered from the structured ones.
  assert.deepEqual(result.plan.tasks[0].readFile, ['README.md'])
  assert.deepEqual(result.plan.tasks[0].writeFile, ['README.md'])
  assert.deepEqual(result.plan.tasks[0].validation, ['node --check README.md'])

  const toolText = messages.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n')
  assert.match(toolText, /Plan proposed\. Awaiting user review\./)
})

test('a rejected plan can be re-proposed in the next turn without re-collecting evidence', async () => {
  // The bug this pins: the evidence ledger used to be a turn-local, so the
  // moment a plan was rejected the next turn started with an empty one. Every
  // context entry then failed "you never read it" and every verify failed "was
  // never run" — the rejection feedback demanded exactly the evidence that had
  // just been thrown away, and re-collecting it burned the 30-call tool budget.
  const ledger = createEvidenceLedger()
  const projectDir = makeProject()
  try {
    // Turn 1 reads and baselines exactly once, then proposes a plan whose anchor
    // is wrong — the realistic reason a plan comes back.
    const first = stubPlanProposal(
      [validStructuredTask({ edits: [{ op: 'modify', path: 'README.md', anchor: '# nope', change: 'x' }] })],
      VALIDATION_PRELUDE,
    )
    const turn1 = await runTurn({ evidence: ledger, projectDir })
    assert.equal(turn1.result.type, 'response', 'the bad anchor is rejected')
    assert.match(feedbackSeenBy(first), /does not appear in the file/)
    assert.equal(ledger.filesRead.size, 1, 'the read is recorded on the shared ledger')
    assert.equal(ledger.baselinesByCommand.size, 1, 'and so is the baseline')

    // Turn 2 fixes the anchor and proposes again — with no read_file and no
    // run_baseline of its own. Under the old behaviour this could not pass.
    const second = stubPlanProposal([validStructuredTask()])
    const turn2 = await runTurn({ evidence: ledger, projectDir })

    assert.equal(turn2.result.type, 'plan', 'the corrected plan validates on the carried evidence')
    const retried = feedbackSeenBy(second)
    assert.doesNotMatch(retried, /never read it/, 'no file has to be read twice')
    assert.doesNotMatch(retried, /never run/, 'no baseline has to be re-recorded')
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('a kind that contradicts the measured exit code is corrected, not rejected', async () => {
  // Whether a command proves a change or guards against a regression is what its
  // exit code says, not a judgement. A model that labelled one the other way used
  // to earn a rejection round for it; now the harness relabels and says so.
  const projectDir = makeProject()
  try {
    stubPlanProposal(
      [validStructuredTask({ verify: [{ command: 'node', args: ['--check', 'README.md'], kind: 'regression-guard' }] })],
      VALIDATION_PRELUDE,
    )
    const { result, events } = await runTurn({ projectDir })
    assert.equal(result.type, 'plan', 'the plan is accepted')
    assert.equal(result.plan.tasks[0].verify[0].kind, 'proves-change', 'the baseline exited 1, so it proves a change')
    assert.ok(
      events.some(e => e.type === 'warning' && /set the kind of 1 verify command/.test(e.text)),
      'the relabel is reported, so a log shows the model was corrected',
    )
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('relabelling does not hide a task that proves nothing: all its commands already pass', async () => {
  const projectDir = makeProject()
  try {
    const proposal = stubPlanProposal([validStructuredTask()], VALIDATION_PRELUDE)
    const { result } = await runTurn({
      projectDir,
      handle: {
        callTool: async tool =>
          tool === 'run_baseline'
            ? JSON.stringify({ exitCode: 0, signal: null, stdout: '', stderr: '' })
            : '# demo\n',
      },
    })
    assert.equal(result.type, 'response')
    assert.match(feedbackSeenBy(proposal), /only regression-guard checks/)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('a verify command the model never ran is measured when the plan is proposed', async () => {
  // A baseline is only an exit code before any change, so the harness takes it
  // rather than spending a model round per command on it.
  const projectDir = makeProject()
  try {
    const ran = []
    stubPlanProposal([validStructuredTask()], [{ name: 'read_file', args: { path: 'README.md' } }])
    const { result, events } = await runTurn({
      projectDir,
      handle: {
        callTool: async (tool, args) => {
          if (tool === 'run_baseline') {
            ran.push(args)
            return JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: '' })
          }
          return '# demo\n'
        },
      },
    })
    assert.equal(result.type, 'plan', 'a plan whose only gap was a missing baseline is accepted')
    assert.equal(ran.length, 1)
    assert.deepEqual(ran[0].args, ['--check', 'README.md'])
    const note = events.find(e => e.type === 'warning' && /measured 1 verify command/.test(e.text))
    assert.ok(note, 'the run says it measured, so a log shows where the exit code came from')
    assert.equal(result.plan.tasks[0].verify[0].baselineExit, 1, 'and the plan carries what was observed')
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('a command the model already ran is not run again', async () => {
  const projectDir = makeProject()
  try {
    let runs = 0
    stubPlanProposal([validStructuredTask()], VALIDATION_PRELUDE)
    const { result } = await runTurn({
      projectDir,
      handle: {
        callTool: async tool => {
          if (tool === 'run_baseline') {
            runs++
            return JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: '' })
          }
          return '# demo\n'
        },
      },
    })
    assert.equal(result.type, 'plan')
    assert.equal(runs, 1, 'the model ran it, the harness did not')
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('a verify command the harness refuses is rejected with the reason, not just "never run"', async () => {
  const projectDir = makeProject()
  try {
    const proposal = stubPlanProposal(
      [validStructuredTask({ verify: [{ command: 'npm', args: ['test'], kind: 'proves-change' }] })],
      [{ name: 'read_file', args: { path: 'README.md' } }],
    )
    const { result } = await runTurn({
      projectDir,
      handle: {
        callTool: async tool =>
          tool === 'run_baseline'
            ? JSON.stringify({ exitCode: -1, signal: null, stdout: '', stderr: "Failed to execute 'npm': Permission denied" })
            : '# demo\n',
      },
    })
    assert.equal(result.type, 'response')
    const feedback = feedbackSeenBy(proposal)
    assert.match(feedback, /'npm test' cannot be run here \(Failed to execute 'npm': Permission denied\)/)
    assert.match(feedback, /not a package manager/)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('a verify command that cannot be run is still rejected, and named', async () => {
  const projectDir = makeProject()
  try {
    const proposal = stubPlanProposal([validStructuredTask()], [{ name: 'read_file', args: { path: 'README.md' } }])
    const { result } = await runTurn({
      projectDir,
      handle: {
        callTool: async tool => {
          if (tool === 'run_baseline') throw new Error('not allowed')
          return '# demo\n'
        },
      },
    })
    assert.equal(result.type, 'response')
    assert.match(feedbackSeenBy(proposal), /was never run/)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('the ledger is dropped when reset, so stale evidence cannot validate a plan', async () => {  // The other half of the contract: once Workers write, the recorded content
  // no longer describes the files, and an anchor must not be checked against it.
  const ledger = createEvidenceLedger()
  stubPlanProposal([validStructuredTask()], VALIDATION_PRELUDE)
  await runTurn({ evidence: ledger })
  assert.equal(ledger.filesRead.size, 1)

  resetEvidenceLedger(ledger)
  assert.equal(ledger.filesRead.size, 0)
  assert.equal(ledger.baselinesByCommand.size, 0)

  // With the ledger emptied, the same plan is rejected for want of evidence.
  stubPlanProposal([validStructuredTask()])
  const { result } = await runTurn({ evidence: ledger })
  assert.equal(result.type, 'response')
})

test('an anchor outside a narrowed read is refused, because it was never shown', async () => {
  // read_file can now return part of a file. The plan validator checks anchors
  // against whatever read_file returned, so a window that hid the rest of the
  // file has to narrow the evidence too — otherwise the model could anchor on
  // text it never saw and the check would pass for the wrong reason.
  const WHOLE = [
    'export function addTodo() {',
    '  return 1',
    '}',
    '',
    'export function removeTodo() {',
    '  return initialTodos.filter(Boolean)',
    '}',
    '',
  ].join('\n')
  // The tool result is a window: only addTodo came back.
  const WINDOW = [
    '# read_file: src/todo.ts — lines 1-3 of 8.',
    '# Anchors must be copied from this text; the rest of the file was not shown.',
    'export function addTodo() {',
    '  return 1',
    '}',
    '',
  ].join('\n')

  const requests = stubPlanProposal(
    [
      {
        id: 'impl',
        title: 'Change removeTodo',
        description: 'why it matters',
        type: 'modify',
        dependsOn: [],
        context: [{ path: 'src/todo.ts', reason: 'the function this changes' }],
        // This anchor lives in the part of the file that was NOT returned.
        edits: [{ op: 'modify', path: 'src/todo.ts', anchor: 'initialTodos.filter(Boolean)', change: 'x' }],
        verify: [{ command: 'node', args: ['--check'], kind: 'proves-change' }],
      },
    ],
    [
      { name: 'read_file', args: { path: 'src/todo.ts', offset: 1, limit: 3 } },
      { name: 'run_baseline', args: { command: 'node', args: ['--check'] } },
    ],
  )

  const { result } = await runTurn({
    handle: {
      callTool: async tool => {
        if (tool === 'run_baseline') {
          return JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: '' })
        }
        return WINDOW
      },
    },
  })

  assert.equal(result.type, 'response', 'the plan is rejected')
  const feedback = feedbackSeenBy(requests)
  assert.match(feedback, /anchor for 'src\/todo\.ts' does not appear in the file/)
  assert.ok(WHOLE.includes('initialTodos.filter(Boolean)'), 'the anchor does exist in the real file')
})

// ---------------------------------------------------------------------------
// The Developer's budget: how much it may do before it must produce a plan.
// ---------------------------------------------------------------------------

/** A provider that makes one tool call per round, forever, and records every request. */
function endlessCalls(toolName, args) {
  const requests = []
  let n = 0
  const restore = useProvider(async (_url, init) => {
    requests.push(JSON.parse(init.body))
    n++
    return sseResponse([
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
          },
          finish_reason: null,
        }],
      },
      toolFinish,
    ])
  })
  return { requests, restore }
}

test('a Developer that only reads is cut off after exactly 30 tool calls', async () => {
  const { requests, restore } = endlessCalls('read_file', { path: 'README.md' })
  try {
    const messages = []
    await runTurn({ messages })

    const results = messages.filter(m => m.role === 'tool').map(m => String(m.content))
    assert.equal(results.length, 30, 'thirty calls ran, then the loop stopped')
    assert.equal(
      messages.filter(m => m.role === 'assistant' && m.tool_calls).flatMap(m => m.tool_calls).length,
      results.length,
      'no tool call is left without an answer',
    )
    assert.equal(requests.length, 30, 'the model was not asked again once the budget was spent')
  } finally {
    restore()
  }
})

test('a round that asks for more calls than remain gets a refusal for the extras, not a dangling call', async () => {
  // One round with 40 parallel reads: 30 fit, the other 10 must still be answered,
  // because a provider rejects an assistant tool call that has no matching result.
  const calls = Array.from({ length: 40 }, (_, i) => ({
    index: i,
    id: `call_${i}`,
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
  }))
  const restore = useProvider(async () => sseResponse([{ choices: [{ delta: { tool_calls: calls }, finish_reason: null }] }, toolFinish]))
  try {
    const messages = []
    await runTurn({ messages })

    const results = messages.filter(m => m.role === 'tool')
    assert.equal(results.length, 40, 'every one of the 40 calls was answered')
    assert.equal(results.filter(m => /Tool call budget exhausted/.test(String(m.content))).length, 10)
  } finally {
    restore()
  }
})

test('search_files is free: it does not use up the tool-call budget', async () => {
  const { requests, restore } = endlessCalls('search_files', { query: 'readme' })
  try {
    const messages = []
    // Free calls are bounded by the iteration and time limits instead, so this
    // run is allowed far more than 30 of them before the loop gives up.
    await runTurn({ messages, summaryIndex: [{ path: 'README.md', symbols: [], imports: 0, exports: 0, lines: 1, preview: '# demo' }] })

    const results = messages.filter(m => m.role === 'tool').map(m => String(m.content))
    assert.equal(results.some(text => /Tool call budget exhausted/.test(text)), false, 'free calls never trip the tool budget')
    assert.ok(requests.length > 30, `more than 30 free calls were allowed (${requests.length})`)
    assert.ok(requests.length <= 61, `but the iteration limit still ends the loop (${requests.length})`)
  } finally {
    restore()
  }
})
