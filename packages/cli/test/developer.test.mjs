import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * A turn spent entirely on tool calls used to print nothing at all. These drive
 * developerConversationTurn against a stubbed provider and assert the progress
 * events actually reach the caller — the mechanism existing is not evidence the
 * caller passes it (that is the 1C regression).
 */

const developerUrl = pathToFileURL(
  join(import.meta.dirname, '..', 'dist', 'agent', 'developer.js'),
).href

// The OpenAI SDK resolves the global fetch when it loads, so the stub has to be
// in place before developer.js is imported. `handler` is what a test swaps in.
let handler = null
globalThis.fetch = (...args) => handler(...args)

const { developerConversationTurn } = await import(developerUrl)

/**
 * One SSE event per chunk. Handing the SDK the whole body as a single string
 * makes its event decoder see one malformed frame — a fake that only works by
 * luck is worse than no fake.
 */
function sseResponse(payloads) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const TOOL_CALL_CHUNK = name => ({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name, arguments: '{"path":"README.md"}' },
          },
        ],
      },
      finish_reason: null,
    },
  ],
})
const TOOL_FINISH = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
const TEXT_CHUNK = { choices: [{ delta: { content: 'done' }, finish_reason: null }] }
const STOP = { choices: [{ delta: {}, finish_reason: 'stop' }] }

/** Round 1 asks for a tool and says nothing; round 2 answers in prose. */
function stubProvider(toolName = 'read_file') {
  let round = 0
  handler = async () =>
    ++round === 1
      ? sseResponse([TOOL_CALL_CHUNK(toolName), TOOL_FINISH])
      : sseResponse([TEXT_CHUNK, STOP])
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-developer-'))
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  return dir
}

async function runTurn(overrides = {}) {
  const dir = makeProject()
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
    rmSync(dir, { recursive: true, force: true })
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
  handler = async (_url, init) => {
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
      return sseResponse([chunk, TOOL_FINISH])
    }
    return sseResponse([TEXT_CHUNK, STOP])
  }
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
  handler = async (_url, init) => {
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
      return sseResponse([chunk, TOOL_FINISH])
    }
    return sseResponse([TEXT_CHUNK, STOP])
  }

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
