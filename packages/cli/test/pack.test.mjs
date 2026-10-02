import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * K2: the context pack.
 *
 * A pack is compiled, not conversed, so the properties that matter are checkable
 * without a model: the same inputs produce the same hash, the degradation order is
 * the one the plan says, and an anchor that has moved says so instead of quietly
 * pointing somewhere else. The last of those is the one that would do real damage
 * if it broke — an anchor copied from a stale pack is an edit in the wrong place,
 * and nothing downstream would notice.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const packUrl = pathToFileURL(join(dist, 'agent', 'pack.js')).href
const paramsUrl = pathToFileURL(join(dist, 'bench', 'params.js')).href
const windowUrl = pathToFileURL(join(dist, 'agent', 'context-window.js')).href
const promptUrl = pathToFileURL(join(dist, 'tasks', 'prompt.js')).href
const { buildContextPack, packBudgetTokens, declarationLines } = await import(packUrl)
const { getModelLimit } = await import(windowUrl)
const { TODAYS_PARAMS } = await import(paramsUrl)
const { legacySystemPrompt, packSystemPrompt, START_MESSAGE } = await import(promptUrl)

const MODEL = 'zen/pack-test'

/** The tree the pack reads, and a handle that reads it. */
function project(files = {}) {
  return {
    async read(path, symbols) {
      const content = files[path]
      if (content === undefined) throw new Error(`Failed to read file '${path}'`)
      if (!symbols || symbols.length === 0) return content
      return `# read_file: ${path} — ${symbols.join(', ')}.\n${content}`
    },
    async list(path) {
      const entries = Object.keys(files)
        .filter(name => name.slice(0, name.lastIndexOf('/')) === (path === '.' ? '' : path))
        .map(name => JSON.stringify({ name, path: name, isDir: false, isMasked: false }))
      return `[${entries.join(',')}]`
    },
  }
}

const withParams = patch => ({ ...TODAYS_PARAMS, contextPack: true, ...patch })

const TASK = {
  id: 't1',
  title: 'Wire the runner',
  description: 'so the suite can call it',
  instructions: ['make run return a tuple'],
  readFile: [],
  writeFile: ['src/a.ts'],
  deleteFile: [],
  createDir: [],
  validation: [],
  type: 'modify',
  verify: [{ command: 'pnpm', args: ['test'], expectExit: 0, kind: 'proves-change' }],
  successCriteria: ['pnpm test exits 0'],
  notes: 'leave the generated header alone',
  edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = 1', change: 'Return a tuple.' }],
}

test('the same inputs give the same pack, and a different file does not', async () => {
  const files = { 'src/a.ts': 'const run = 1\nconsole.log(run)\n' }
  const input = { task: TASK, params: withParams({}), model: MODEL, ...project(files) }

  const first = await buildContextPack(input)
  const second = await buildContextPack({ ...input, ...project(files) })
  assert.equal(first.hash, second.hash)
  assert.equal(first.text, second.text)
  assert.match(first.hash, /^[0-9a-f]{64}$/)

  const moved = await buildContextPack({
    ...input,
    ...project({ 'src/a.ts': 'const run = 2\nconsole.log(run)\n' }),
  })
  assert.notEqual(moved.hash, first.hash, 'a changed file must change the hash')
})

test('the sections come out in the plan\'s order, with the fixed ones marked', async () => {
  const pack = await buildContextPack({
    task: TASK,
    params: withParams({}),
    model: MODEL,
    ...project({ 'src/a.ts': 'const run = 1\n' }),
    contracts: [
      { id: 'c1', statement: 'run returns a tuple.', producedBy: 't1', consumedBy: ['t2'] },
    ],
    upstream: {
      direct: [{ taskId: 't0', title: 'Add the type', filesWritten: ['src/types.ts'], interfaces: ['export type Run'], summary: 'added Run' }],
      transitive: [{ taskId: 'tz', title: 'Older thing', filesWritten: ['src/z.ts'], interfaces: ['export function z'], summary: 'did z' }],
    },
    projectCard: '- TypeScript (Node), pnpm',
    previousAttempt: 'This task has been attempted 1 time(s) before.',
  })

  assert.deepEqual(pack.sections.map(s => s.name), [
    'Task',
    'Done means',
    'Previous attempt',
    'Edits',
    'Contracts',
    'Scope',
    'Upstream results',
    'Context excerpts',
    'Project card',
  ])
  // The hints exist only when something was cut, and they are last.
  assert.deepEqual(pack.sections.map(s => s.name).includes('Retrieval hints'), false)
  // Only the excerpts degrade; everything else is what the Worker cannot do without.
  assert.deepEqual(pack.sections.filter(s => !s.fixed).map(s => s.name), ['Context excerpts'])
})

test('the pack shows the anchor where it is, with the configured window around it', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  lines[19] = 'const run = 1'
  const pack = await buildContextPack({
    task: { ...TASK, edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = 1', change: 'x' }] },
    params: withParams({ anchorContextLines: 3 }),
    model: MODEL,
    ...project({ 'src/a.ts': `${lines.join('\n')}\n` }),
  })

  const edits = pack.sections.find(s => s.name === 'Edits').text
  assert.match(edits, /as planned, line 20/)
  assert.match(edits, /17 \| line 17/)
  assert.match(edits, /23 \| line 23/)
  assert.doesNotMatch(edits, /16 \| line 16/)
  assert.match(edits, /16 earlier line\(s\)/)
  assert.doesNotMatch(edits, /stale/)
  assert.deepEqual(pack.staleAnchors, [])
  assert.deepEqual(pack.relocatedAnchors, [])
  assert.deepEqual(pack.paths, ['src/a.ts'])
})

test('an anchor that moved is relocated by its most distinctive line', async () => {
  // The anchor is gone, but one of its lines appears exactly once.
  const pack = await buildContextPack({
    task: { ...TASK, edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = 1\nrunIt()\n', change: 'x' }] },
    params: withParams({ anchorContextLines: 2 }),
    model: MODEL,
    ...project({ 'src/a.ts': 'const run = 2\nrunIt()\nconst after = 3\n' }),
  })

  const edits = pack.sections.find(s => s.name === 'Edits').text
  assert.match(edits, /The anchor has moved/)
  assert.match(edits, /relocated, line 2/)
  assert.deepEqual(pack.relocatedAnchors, ['src/a.ts'])
  assert.deepEqual(pack.staleAnchors, [])
})

test('an anchor with no unique line left is stale, and says so', async () => {
  const pack = await buildContextPack({
    task: { ...TASK, edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'gone entirely\n', change: 'x' }] },
    params: withParams({}),
    model: MODEL,
    ...project({ 'src/a.ts': 'const run = 2\nconst run = 3\n' }),
  })

  const edits = pack.sections.find(s => s.name === 'Edits').text
  assert.match(edits, /planned anchor is stale/)
  assert.equal(pack.staleAnchors.length, 1)
  assert.deepEqual(pack.relocatedAnchors, [])
  assert.deepEqual(pack.paths, [], 'a stale anchor shows no content, so the pack claims no path')
})

test('a create edit shows the directory it goes in, and no anchor', async () => {
  const pack = await buildContextPack({
    task: { ...TASK, edits: [{ path: 'src/new.ts', op: 'create', change: 'New module.' }] },
    params: withParams({}),
    model: MODEL,
    ...project({ 'src/a.ts': 'const run = 1\n' }),
  })

  const edits = pack.sections.find(s => s.name === 'Edits').text
  assert.match(edits, /does not exist yet/)
  assert.match(edits, /src\/a\.ts/)
})

test('a deleted file is named as one, and read from nowhere', async () => {
  const pack = await buildContextPack({
    task: { ...TASK, edits: [{ path: 'src/old.ts', op: 'delete', change: 'Obsolete.' }] },
    params: withParams({}),
    model: MODEL,
    ...project({}),
  })

  const edits = pack.sections.find(s => s.name === 'Edits').text
  assert.match(edits, /delete_file/)
  assert.deepEqual(pack.paths, [])
})

test('over budget, the excerpts degrade last ref first: body, then signature, then path', async () => {
  const files = {}
  const context = []
  // f2 declares fifty things, so its signature is worth as much as its body and
  // the ladder has to go further with it; f0 and f1 declare one each.
  for (let i = 0; i < 3; i++) {
    const declarations = i === 2 ? 50 : 1
    files[`src/f${i}.ts`] =
      Array.from({ length: declarations }, (_, d) => `export function fn${i}_${d}() {`).join('\n') +
      '\n' +
      '// padding\n'.repeat(300) +
      '}\n'
    context.push({ path: `src/f${i}.ts`, reason: `the ${i}th one` })
  }
  // A budget of about a thousand characters, so nothing fits whole.
  const params = withParams({ packWindowShare: 0.002, anchorContextLines: 0 })

  const pack = await buildContextPack({ task: { ...TASK, context }, params, model: MODEL, ...project(files) })

  // Every cut is named, with the call that fetches it back.
  assert.ok(pack.omitted.length > 0, 'an over-budget pack says what it cut')
  for (const hint of pack.omitted) assert.match(hint, /read_file\(\{ "path": "src\/f\d\.ts" \}\)/)
  const hints = pack.sections.find(s => s.name === 'Retrieval hints')
  assert.ok(hints, 'a pack that cut something says so in its own section')
  assert.match(hints.text, /these parts of the pack were cut/i)

  // Hints read in the order the refs were declared, not in the order they were cut.
  const order = ['src/f0.ts', 'src/f1.ts', 'src/f2.ts']
  const mentioned = pack.omitted.map(hint => order.find(path => hint.includes(path)))
  assert.deepEqual([...mentioned].sort(), mentioned, 'the hints are grouped and in plan order')

  // Last ref first is visible as depth, not as order: f2 is reached first, so it
  // absorbs the cuts, and f0 and f1 only ever lose their bodies.
  const cutsOf = path => pack.omitted.filter(hint => hint.includes(path))
  assert.ok(cutsOf('src/f0.ts').every(hint => /the body was cut/.test(hint)))
  assert.ok(cutsOf('src/f1.ts').every(hint => /the body was cut/.test(hint)))
  assert.equal(cutsOf('src/f2.ts').length, 2)

  // f2 goes all the way: fifty declarations do not fit either.
  const f2 = pack.omitted.filter(hint => hint.includes('src/f2.ts'))
  assert.ok(f2.some(hint => /the body was cut/.test(hint)), 'f2 lost its body')
  assert.ok(f2.some(hint => /cut to its path/.test(hint)), 'f2 lost its signature as well')
  assert.deepEqual(pack.paths, ['src/f0.ts', 'src/f1.ts'], 'f2 shows nothing, so the pack does not claim it')
})

test('a pack is never over its own budget when the excerpts can be cut to fit', async () => {
  const files = {}
  const context = []
  for (let i = 0; i < 6; i++) {
    files[`src/f${i}.ts`] = `export function fn${i}() {\n${'  // padding\n'.repeat(200)}\n}\n`
    context.push({ path: `src/f${i}.ts`, reason: `the ${i}th one` })
  }
  const params = withParams({ packWindowShare: 0.05 })
  const pack = await buildContextPack({ task: { ...TASK, context }, params, model: MODEL, ...project(files) })

  const budgetChars = Math.floor(getModelLimit(MODEL) * 0.05 * 4)
  assert.ok(pack.text.length <= budgetChars, `pack is ${pack.text.length} chars against ${budgetChars}`)
})

test('a ref kept only as declarations says so, and one cut to nothing says that too', async () => {
  const files = {
    'src/one.ts': 'export function one() {\n' + 'x\n'.repeat(2000) + '}\n',
    'src/many.ts':
      Array.from({ length: 60 }, (_, i) => `export function many${i}() {`).join('\n') +
      '\n' +
      'y\n'.repeat(400) +
      '}\n',
  }
  const pack = await buildContextPack({
    task: {
      ...TASK,
      context: [
        { path: 'src/one.ts', reason: 'one declaration' },
        { path: 'src/many.ts', reason: 'sixty declarations' },
      ],
    },
    params: withParams({ packWindowShare: 0.004 }),
    model: MODEL,
    ...project(files),
  })

  const excerpts = pack.sections.find(s => s.name === 'Context excerpts').text
  assert.match(excerpts, /Declarations only/)
  assert.match(excerpts, /\(not shown\)/)
  // The one that kept declarations still shows code, so the pack claims it.
  assert.deepEqual(pack.paths, ['src/one.ts'])
})

test('a ref read by its symbols is sliced, and the reason is always shown', async () => {
  const pack = await buildContextPack({
    task: {
      ...TASK,
      context: [{ path: 'src/a.ts', reason: 'the entry point', symbols: ['run'] }],
    },
    params: withParams({}),
    model: MODEL,
    ...project({ 'src/a.ts': 'const run = 1\n' }),
  })

  const excerpts = pack.sections.find(s => s.name === 'Context excerpts').text
  assert.match(excerpts, /the entry point/)
  assert.match(excerpts, /sliced to run/)
})

test('a file that cannot be read is named, not left out', async () => {
  const pack = await buildContextPack({
    task: {
      ...TASK,
      context: [{ path: 'src/missing.ts', reason: 'supposed to be there' }],
      edits: [{ path: 'src/missing.ts', op: 'modify', anchor: 'anything', change: 'x' }],
    },
    params: withParams({}),
    model: MODEL,
    ...project({}),
  })

  const text = pack.text
  assert.match(text, /could not be read/)
  assert.match(text, /src\/missing\.ts/)
  // A file that will not read is not the same as a stale anchor, and the pack
  // says which: one needs a read, the other needs a decision.
  assert.match(text, /The file could not be read/)
  assert.doesNotMatch(text, /planned anchor is stale/)
})

test('contracts reach the pack only when they name this task', async () => {
  const contracts = [
    { id: 'mine', statement: 'I produce it.', producedBy: 't1', consumedBy: ['t2'] },
    { id: 'theirs', statement: 'Someone else produced it.', producedBy: 't9', consumedBy: ['t1'] },
    { id: 'unrelated', statement: 'Not this task.', producedBy: 't9', consumedBy: ['t9'] },
  ]
  const pack = await buildContextPack({
    task: TASK,
    params: withParams({}),
    model: MODEL,
    ...project({ 'src/a.ts': 'const run = 1\n' }),
    contracts,
  })

  const section = pack.sections.find(s => s.name === 'Contracts').text
  assert.match(section, /mine/)
  assert.match(section, /theirs/)
  assert.doesNotMatch(section, /unrelated/)
  assert.match(section, /produced by: t1 \(this task\)/)
})

test('a direct handoff is in full and a transitive one is interfaces only', async () => {
  const pack = await buildContextPack({
    task: TASK,
    params: withParams({}),
    model: MODEL,
    ...project({ 'src/a.ts': 'const run = 1\n' }),
    upstream: {
      direct: [
        {
          taskId: 't0',
          title: 'Add the type',
          filesWritten: ['src/types.ts'],
          interfaces: ['export type Run'],
          summary: 'Run is a tuple now; callers must destructure it.',
        },
      ],
      transitive: [
        {
          taskId: 'tz',
          title: 'Older thing',
          filesWritten: ['src/z.ts'],
          interfaces: ['export function z'],
          summary: 'a long story nobody two steps away needs',
        },
      ],
    },
  })

  const section = pack.sections.find(s => s.name === 'Upstream results').text
  assert.match(section, /Run is a tuple now/)
  assert.match(section, /export type Run/)
  assert.doesNotMatch(section, /a long story nobody two steps away needs/)
  assert.match(section, /summary omitted/)
  assert.match(section, /export function z/)
})

test('done means states the criteria and the command with the exit it must reach', async () => {
  const pack = await buildContextPack({
    task: TASK,
    params: withParams({}),
    model: MODEL,
    ...project({ 'src/a.ts': 'const run = 1\n' }),
  })
  const section = pack.sections.find(s => s.name === 'Done means').text
  assert.match(section, /pnpm test exits 0/)
  assert.match(section, /pnpm test \(expect exit 0\)/)
})

test('the legacy prompt is byte for byte what the Worker has always been given', () => {
  // The replay fixture pins the calls and the event stream; this pins the prompt
  // itself, so a reworded rule or a re-ordered list cannot pass unnoticed. The
  // prompt has never had blank lines in it: the builder drops falsy lines, which
  // is why this reads as one block.
  const task = {
    title: 'Inspect the tree',
    description: 'so the suite can see it',
    instructions: ['read the files', 'then stop'],
    readFile: ['a.ts', 'b.ts'],
    writeFile: ['c.ts'],
    deleteFile: [],
    createDir: ['src/out'],
  }
  assert.equal(
    legacySystemPrompt(task, false),
    'You are a worker agent. Follow the instructions EXACTLY. Do not deviate.\n' +
      'TASK: Inspect the tree\n' +
      'WHY: so the suite can see it\n' +
      'INSTRUCTIONS (follow in order):\n' +
      '1. read the files\n' +
      '2. then stop\n' +
      'FILES TO READ: a.ts, b.ts\n' +
      'FILES TO WRITE: c.ts\n' +
      'FILES TO DELETE: (none)\n' +
      'DIRS TO CREATE: src/out\n' +
      'RULES:\n' +
      '- Execute each instruction step by step\n' +
      '- Read each readFile first to understand the current code\n' +
      '- Make precise edits using edit_file (not write_file for existing files)\n' +
      '- Use write_file only for new files\n' +
      '- Use delete_file only for files listed under FILES TO DELETE\n' +
      '- Use create_dir only for directories listed under DIRS TO CREATE\n' +
      '- Use run_command to execute shell commands (npm install, npm test, git, etc.)\n' +
      '- After completing all instructions, respond with a brief summary',
  )
  // A task with no description drops that line rather than printing "WHY:".
  assert.equal(legacySystemPrompt({ ...task, description: null }, false).includes('WHY:'), false)
  // The one rule that depends on the reads already being in hand.
  assert.equal(legacySystemPrompt(task, true).includes('Read each readFile first'), false)
  assert.equal(legacySystemPrompt(task, false).includes('Read each readFile first'), true)
})

test('the pack prompt puts the pack after the role rules, and the first message only says start', () => {
  const prompt = packSystemPrompt('## 1. Task\n\nTitle: x')
  assert.ok(prompt.startsWith('You are a worker agent.'))
  assert.ok(prompt.endsWith('## 1. Task\n\nTitle: x'))
  assert.equal(START_MESSAGE, 'Execute the task now.')
})

test('the pack budget is packWindowShare of the model window, and the caller may compare against it', () => {
  assert.equal(packBudgetTokens(TODAYS_PARAMS, MODEL), Math.floor(getModelLimit(MODEL) * 0.35))
})

test('declarationLines keeps only top-level declarations, trimmed and deduped', () => {
  assert.deepEqual(
    declarationLines('export function a() {\n  const x = 1\n}\n\ndef b():\n  pass\nclass C {}\nexport function a() {}'),
    ['export function a() {', 'def b():', 'class C {}', 'export function a() {}'],
  )
})