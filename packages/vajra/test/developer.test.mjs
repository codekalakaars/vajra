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

test('a rejection states the exit code already measured, so a kind is a relabel', async () => {
  // A verify entry's kind is decided by the exit code the Developer already
  // recorded, and a rejection that omits the number sends it back to
  // run_baseline to find out what it measured an hour of turns ago. In a real
  // session that was twenty-six baseline runs across four proposals, twenty-five
  // of them distinct commands, because every rejection restarted the measuring.
  const projectDir = makeProject()
  try {
    // The same command, labelled as the kind its recorded exit contradicts.
    const proposal = stubPlanProposal(
      [validStructuredTask({ verify: [{ command: 'node', args: ['--check', 'README.md'], kind: 'regression-guard' }] })],
      VALIDATION_PRELUDE,
    )
    const { result } = await runTurn({ projectDir })
    assert.equal(result.type, 'response', 'the mismatched kind is rejected')

    const feedback = feedbackSeenBy(proposal)
    assert.match(feedback, /already fails/, 'the validator still says what is wrong')
    // And the rejection carries the measurement, with the kind it implies — so
    // the next call is the plan with one word changed, not another run.
    assert.match(
      feedback,
      /exit \d+\s+node --check README\.md\s+→ kind proves-change/,
      `the recorded exit and the kind it implies are both in the rejection: ${JSON.stringify(feedback)}`,
    )
    assert.match(feedback, /do not re-run them/, 'and the rejection says so outright')
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('a plan whose verify commands were never measured is told to measure them', async () => {
  // The other side of the same rule: there is nothing to restate, so the
  // rejection must not imply there is.
  const projectDir = makeProject()
  try {
    const proposal = stubPlanProposal(
      [validStructuredTask()],
      [{ name: 'read_file', args: { path: 'README.md' } }],
    )
    const { result } = await runTurn({ projectDir })
    assert.equal(result.type, 'response', 'a plan with an unmeasured verify is rejected')
    const feedback = feedbackSeenBy(proposal)
    assert.match(feedback, /was never run/)
    assert.doesNotMatch(feedback, /do not re-run them/, 'nothing is claimed to be measured')
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

test('a stub the Developer wrote is evidence it can plan against', async () => {
  // The point of write_stub: Phase One asks for a stub to exist before a test
  // can be written against it, but a plan is not executed until it is confirmed.
  // Without this the Developer could only specify a stub it had never seen, and
  // never run the test it specified against one. The content it wrote has to
  // count as something it read, or the plan is told it never opened the file.
  const STUB = 'export const answer = 0\n'
  const handle = {
    callTool: async (tool, args) => {
      if (tool === 'write_stub') return `Created ${args.path}.`
      if (tool === 'run_baseline') {
        return JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: '' })
      }
      return STUB
    },
  }

  stubPlanProposal(
    [
      {
        id: 'impl',
        title: 'Make answer 42',
        description: 'why it matters',
        type: 'modify',
        dependsOn: [],
        context: [{ path: 'src/answer.ts', reason: 'the constant this changes' }],
        // `modify`, not `create`: the file genuinely exists now.
        edits: [{ op: 'modify', path: 'src/answer.ts', anchor: 'export const answer = 0', change: '42' }],
        verify: [{ command: 'node', args: ['--test'], kind: 'proves-change' }],
      },
    ],
    [
      { name: 'write_stub', args: { path: 'src/answer.ts', content: STUB } },
      { name: 'run_baseline', args: { command: 'node', args: ['--test'] } },
    ],
  )

  const { result } = await runTurn({ handle })

  assert.equal(result.type, 'plan', `a plan built on the Developer's own stub must validate: ${JSON.stringify(result)}`)
  assert.deepEqual(result.plan.tasks[0].writeFile, ['src/answer.ts'])
})

test('a deleted stub stops counting as available evidence', async () => {
  // Otherwise a plan could still cite a file that no longer exists, and the
  // validator would check an anchor against content that is gone.
  const handle = {
    callTool: async (tool, args) => {
      if (tool === 'write_stub') return `Created ${args.path}.`
      if (tool === 'delete_stub') return `Deleted ${args.path}.`
      if (tool === 'run_baseline') {
        return JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: '' })
      }
      return 'export const answer = 0\n'
    },
  }

  const requests = stubPlanProposal(
    [
      {
        id: 'impl',
        title: 'Make answer 42',
        description: 'why it matters',
        type: 'modify',
        dependsOn: [],
        context: [{ path: 'src/answer.ts', reason: 'the constant this changes' }],
        edits: [{ op: 'modify', path: 'src/answer.ts', anchor: 'export const answer = 0', change: '42' }],
        verify: [{ command: 'node', args: ['--test'], kind: 'proves-change' }],
      },
    ],
    [
      { name: 'write_stub', args: { path: 'src/answer.ts', content: 'export const answer = 0\n' } },
      { name: 'delete_stub', args: { path: 'src/answer.ts' } },
      { name: 'run_baseline', args: { command: 'node', args: ['--test'] } },
    ],
  )

  const { result } = await runTurn({ handle })

  assert.equal(result.type, 'response', 'a plan citing a deleted stub is rejected')
  assert.match(feedbackSeenBy(requests), /never read it/)
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
