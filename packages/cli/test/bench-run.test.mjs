import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { useProvider, sseResponse, roundChunks, scriptedProvider } from './_provider.mjs'
import { useTempVajraHome } from './_isolate.mjs'

/**
 * `vajra bench`, against a scripted model and no network.
 *
 * The suites here are built in a temp dir rather than checked in: what is under
 * test is the runner's contract — the exit codes, the result file, and the one
 * source of the arrangement — and a checked-in suite would be Batch E's to own.
 *
 * The stub is a *routing* provider, not `scriptedProvider`'s single script,
 * because two tasks run at once and each one's rounds have to be its own: the
 * target file is in the Worker's system prompt, which is also how a real Worker
 * knows what it was asked to do.
 */

useTempVajraHome('vajra-bench-run-')

const benchUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'bench', 'run.js')).href
const configUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'config.js')).href
const { runBench } = await import(benchUrl)
const { loadWorkerParams } = await import(configUrl)

/** The repo's own arrangement, so a test states which config it ran with. */
const CONFIG_PATH = fileURLToPath(new URL('../../../bench/config.json', import.meta.url))
const REAL_CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))

/** Valid JavaScript, so a task's `node --check` verify passes once it is written. */
const WRITTEN = 'module.exports = { written: true }\n'

/** The environment a run needs: a credential, and nothing else. */
function withApiKey(fn) {
  const previous = process.env.OPENCODE_API_KEY
  process.env.OPENCODE_API_KEY = 'sk-bench-test'
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previous
  })
}

/**
 * A model that writes whatever file its prompt names, then stops asking.
 *
 * One round of `write_file`, one of prose: the prose is what ends the Worker's
 * loop, and the loop has to end for the task's own verify commands to run.
 */
function workerProvider() {
  const seen = []
  const restore = useProvider(async (_url, init) => {
    const body = JSON.parse(init.body)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const system = messages.find(m => m.role === 'system')?.content ?? ''
    if (!system.startsWith('You are a worker agent')) {
      throw new Error('bench must not ask a Developer anything')
    }
    const target = (system.match(/FILES TO WRITE:\s*(.*)/) ?? [])[1]?.trim().split(',')[0]
    seen.push({ target, hasToolResult: messages.some(m => m.role === 'tool') })
    const round = messages.some(m => m.role === 'tool')
      ? { text: 'task complete' }
      : { toolCalls: [{ name: 'write_file', args: { path: target, content: WRITTEN } }] }
    return sseResponse(roundChunks(round))
  })
  return { seen, restore }
}

/** The suite a run is measured on: two independent tasks, one file each. */
function makeSuite(t, { acceptance, tasks, fixture = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-suite-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  mkdirSync(join(dir, 'fixture'), { recursive: true })
  mkdirSync(join(dir, 'accept'), { recursive: true })
  for (const [name, content] of Object.entries(fixture)) {
    writeFileSync(join(dir, 'fixture', name), content, 'utf-8')
  }

  const planTasks = tasks ?? [
    {
      id: 't1',
      title: 'Write out-1.js',
      description: 'Create out-1.js',
      edits: [{ op: 'create', path: 'out-1.js', change: 'create the module' }],
      verify: [{ command: 'node', args: ['--check', 'out-1.js'], kind: 'proves-change' }],
      type: 'create',
    },
    {
      id: 't2',
      title: 'Write out-2.js',
      description: 'Create out-2.js',
      edits: [{ op: 'create', path: 'out-2.js', change: 'create the module' }],
      verify: [{ command: 'node', args: ['--check', 'out-2.js'], kind: 'proves-change' }],
      type: 'create',
    },
  ]

  writeFileSync(
    join(dir, 'plan.json'),
    `${JSON.stringify(
      {
        summary: 'two independent tasks',
        acceptance: acceptance ?? { command: process.execPath, args: ['--test', 'accept/accept.test.mjs'] },
        tasks: planTasks,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  )

  writeFileSync(
    join(dir, 'accept', 'accept.test.mjs'),
    `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const EXPECTED = ${JSON.stringify(WRITTEN)}

${planTasks
  .map(task => {
    const path = task.edits[0].path
    return `test(${JSON.stringify(`${path} was written`)}, () => {
  assert.equal(readFileSync(new URL('../${path}', import.meta.url), 'utf-8'), EXPECTED)
})`
  })
  .join('\n\n')}
`,
    'utf-8',
  )

  return dir
}

/** Where a run's result went, and what it said. */
function resultAt(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function outPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-out-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'result.json')
}

test('a two-task suite runs to completion and exits 0', async t => {
  const suite = makeSuite(t)
  const out = outPath(t)
  const provider = workerProvider()
  t.after(() => provider.restore())

  const lines = []
  const code = await withApiKey(() =>
    runBench({ allowUnenforced: true, suiteDir: suite, configPath: CONFIG_PATH, out, write: line => lines.push(line) }),
  )

  assert.equal(code, 0, lines.join('\n'))
  const result = resultAt(out)
  assert.equal(result.success, true)
  assert.equal(result.failureReason, undefined)
  assert.equal(result.suite, suite.split('/').pop())
  assert.deepEqual(result.config, REAL_CONFIG, 'the result records the config it ran with')
  assert.ok(result.wallMs > 0, 'a run that did work has a wall clock')
  assert.deepEqual(
    result.tasks.map(t => t.status),
    ['done', 'done'],
  )
  // Both Workers wrote their own file, so the run really was two tasks.
  assert.deepEqual(
    provider.seen.filter(r => !r.hasToolResult).map(r => r.target).sort(),
    ['out-1.js', 'out-2.js'],
  )
})

test('a failing acceptance command exits 1 and says why', async t => {
  // A suite whose acceptance test asserts something the run cannot produce: the
  // tasks complete, and the run still fails, because a run succeeds only when
  // the suite's own tests pass.
  const suite = makeSuite(t, {
    acceptance: { command: process.execPath, args: ['--test', 'accept/accept.test.mjs'] },
  })
  writeFileSync(
    join(suite, 'accept', 'accept.test.mjs'),
    `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

test('a file no task creates', () => {
  assert.equal(existsSync(new URL('../never-made.js', import.meta.url).pathname), true)
})
`,
    'utf-8',
  )
  const out = outPath(t)
  const provider = workerProvider()
  t.after(() => provider.restore())

  const lines = []
  const code = await withApiKey(() =>
    runBench({ allowUnenforced: true, suiteDir: suite, configPath: CONFIG_PATH, out, write: line => lines.push(line) }),
  )

  assert.equal(code, 1, lines.join('\n'))
  const result = resultAt(out)
  assert.equal(result.success, false)
  assert.match(result.failureReason, /acceptance command failed \(exit 1\)/)
  // The tasks did finish: the failure is the suite's, not the arrangement's.
  assert.deepEqual(
    result.tasks.map(t => t.status),
    ['done', 'done'],
  )
})

test('a plan whose verify already passes is a setup error, not a failed run', async t => {
  // The fixture ships the file the task claims to create, so the `proves-change`
  // cannot prove anything. Measured against the real fixture, not asserted.
  const suite = makeSuite(t, {
    fixture: { 'out-1.js': WRITTEN },
    tasks: [
      {
        id: 't1',
        title: 'Write out-1.js',
        description: 'Create out-1.js',
        edits: [{ op: 'create', path: 'out-1.js', change: 'create the module' }],
        verify: [{ command: 'node', args: ['--check', 'out-1.js'], kind: 'proves-change' }],
        type: 'create',
      },
    ],
  })
  const errors = []
  const code = await withApiKey(() =>
    runBench({ allowUnenforced: true,
      suiteDir: suite,
      configPath: CONFIG_PATH,
      write: () => {},
      writeError: line => errors.push(line),
    }),
  )

  assert.equal(code, 2, errors.join('\n'))
  assert.match(errors.join('\n'), /bench /)
})

test('a missing config key exits 2 and names the key', async t => {
  const suite = makeSuite(t)
  const broken = join(suite, 'broken-config.json')
  const config = { ...REAL_CONFIG }
  delete config.retries
  writeFileSync(broken, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')

  const errors = []
  const code = await withApiKey(() =>
    runBench({ allowUnenforced: true,
      suiteDir: suite,
      configPath: broken,
      write: () => {},
      writeError: line => errors.push(line),
    }),
  )

  assert.equal(code, 2, errors.join('\n'))
  assert.match(errors.join('\n'), /missing required key 'retries'/)
})

test('an invalid value exits 2 and names the key', async t => {
  const suite = makeSuite(t)
  const broken = join(suite, 'broken-config.json')
  writeFileSync(
    broken,
    `${JSON.stringify({ ...REAL_CONFIG, scheduleOrder: 'shortest-first' }, null, 2)}\n`,
    'utf-8',
  )

  const errors = []
  const code = await withApiKey(() =>
    runBench({ allowUnenforced: true,
      suiteDir: suite,
      configPath: broken,
      write: () => {},
      writeError: line => errors.push(line),
    }),
  )

  assert.equal(code, 2, errors.join('\n'))
  assert.match(errors.join('\n'), /'scheduleOrder' must be one of plan, critical-path, most-dependents/)
})

test('a suite missing fixture/ exits 2 before anything runs', async t => {
  const suite = makeSuite(t)
  rmSync(join(suite, 'fixture'), { recursive: true, force: true })

  const errors = []
  const code = await withApiKey(() =>
    runBench({ allowUnenforced: true,
      suiteDir: suite,
      configPath: CONFIG_PATH,
      write: () => {},
      writeError: line => errors.push(line),
    }),
  )

  assert.equal(code, 2)
  assert.match(errors.join('\n'), /missing fixture\//)
})

test('no VAJRA_* variable changes a loaded value', async t => {
  const file = join(makeSuite(t), 'candidate.json')
  writeFileSync(file, `${JSON.stringify(REAL_CONFIG, null, 2)}\n`, 'utf-8')

  const before = loadWorkerParams(file)
  // Every knob the session reads from the environment, pointed somewhere else.
  const planted = {
    VAJRA_MODEL: 'go/planted',
    VAJRA_WORKER_MODEL: 'go/planted',
    VAJRA_MANAGER_MODEL: 'go/planted',
    VAJRA_DEVELOPER_MODEL: 'go/planted',
    VAJRA_CONCURRENCY: '99',
    VAJRA_RETRIES: '99',
    VAJRA_READ_LOCKS: 'shared',
    VAJRA_SCHEDULE_ORDER: 'most-dependents',
    VAJRA_TASK_TIMEOUT_SEC: '1',
    VAJRA_PRELOAD_READS: 'true',
  }
  const saved = {}
  for (const [key, value] of Object.entries(planted)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  try {
    assert.deepEqual(loadWorkerParams(file), before)
    assert.equal(before.concurrency, REAL_CONFIG.concurrency)
    assert.equal(before.workerModel, REAL_CONFIG.workerModel)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('a run does not write a session into the store', async t => {
  const suite = makeSuite(t)
  const out = outPath(t)
  const provider = workerProvider()
  t.after(() => provider.restore())

  const code = await withApiKey(() => runBench({ allowUnenforced: true, suiteDir: suite, configPath: CONFIG_PATH, out, write: () => {} }))
  assert.equal(code, 0)

  const persistUrl = pathToFileURL(
    join(import.meta.dirname, '..', 'dist', 'persist', 'index.js'),
  ).href
  const { listSessions } = await import(persistUrl)
  // Ten repetitions per suite must not leave ten records behind.
  assert.deepEqual(listSessions(), [])
})

test('the working copy is thrown away, unless --keep asks for it', async t => {
  const suite = makeSuite(t)
  const kept = []
  const provider = workerProvider()
  t.after(() => provider.restore())

  await withApiKey(() =>
    runBench({ allowUnenforced: true,
      suiteDir: suite,
      configPath: CONFIG_PATH,
      out: outPath(t),
      keepProject: true,
      write: line => kept.push(line),
    }),
  )
  const match = kept.find(line => line.startsWith('working copy kept at '))
  assert.ok(match, kept.join('\n'))
  const dir = match.slice('working copy kept at '.length)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.ok(existsSync(dir))
  assert.ok(existsSync(join(dir, 'out-1.js')), 'the kept copy is the finished tree')
})

test('the CLI documents the bench contract', async () => {
  const cliEntry = join(import.meta.dirname, '..', 'dist', 'index.js')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)(process.execPath, [cliEntry, 'bench', '--help'], {
    timeout: 10000,
  })
  assert.match(stdout, /--config/)
  assert.match(stdout, /--out/)
  assert.match(stdout, /exit 2|2 {2}setup error/i)
  // The point of the command, said where someone reading --help will see it.
  assert.match(stdout, /bench\/config\.json/)
})

// `scriptedProvider` is the suite's default fake; the routing provider above is
// what a two-task run needs. Both are exercised here so the default stays honest.
test('scriptedProvider still drives a single-task suite', async t => {
  const suite = makeSuite(t, {
    tasks: [
      {
        id: 'only',
        title: 'Write out-1.js',
        description: 'Create out-1.js',
        edits: [{ op: 'create', path: 'out-1.js', change: 'create the module' }],
        verify: [{ command: 'node', args: ['--check', 'out-1.js'], kind: 'proves-change' }],
        type: 'create',
      },
    ],
  })
  const { restore } = scriptedProvider([
    { toolCalls: [{ name: 'write_file', args: { path: 'out-1.js', content: WRITTEN } }] },
    { text: 'task complete' },
  ])
  t.after(() => restore())

  const out = outPath(t)
  const code = await withApiKey(() => runBench({ allowUnenforced: true, suiteDir: suite, configPath: CONFIG_PATH, out, write: () => {} }))

  assert.equal(code, 0)
  assert.equal(resultAt(out).success, true)
})

// ---------------------------------------------------------------------------
// The context switches, through a whole run. `bench/config.json` has them all
// off, so a run here is today's behaviour by default and each test below states
// the one it turned on.
// ---------------------------------------------------------------------------

/** The committed config with `patch` on top, written where the runner can read it. */
function candidateConfig(patch) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-bench-config-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, `${JSON.stringify({ ...REAL_CONFIG, ...patch }, null, 2)}\n`, 'utf-8')
  return file
}

/**
 * A provider that writes whatever file its prompt names and records the system
 * prompts it was given.
 *
 * The routing is the same as `workerProvider` — the target file is named in the
 * brief either way — so a run behaves the same with the pack on as with it off,
 * which is what makes the two runs comparable.
 */
function packAwareProvider() {
  const packs = []
  const restore = useProvider(async (_url, init) => {
    const body = JSON.parse(init.body)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const system = messages.find(m => m.role === 'system')?.content ?? ''
    const isPack = system.includes('## 1. Task')
    if (isPack) packs.push(system)
    const target = isPack
      ? (system.match(/You may write: ([^\n]+)/) ?? [])[1]?.trim().split(',')[0]
      : (system.match(/FILES TO WRITE:\s*(.*)/) ?? [])[1]?.trim().split(',')[0]
    const round = messages.some(m => m.role === 'tool')
      ? { text: 'task complete' }
      : { toolCalls: [{ name: 'write_file', args: { path: target, content: WRITTEN } }] }
    return sseResponse(roundChunks(round))
  })
  return { packs, restore }
}

test('a run with the pack on starts every Worker from its pack, and still passes', async t => {
  const suite = makeSuite(t)
  const out = outPath(t)
  const provider = packAwareProvider()
  t.after(() => provider.restore())

  const lines = []
  const code = await withApiKey(() =>
    runBench({
      allowUnenforced: true,
      suiteDir: suite,
      configPath: candidateConfig({ contextPack: true }),
      out,
      write: line => lines.push(line),
    }),
  )

  assert.equal(code, 0, lines.join('\n'))
  assert.ok(provider.packs.length >= 1, 'at least one Worker was started from a pack')
  for (const pack of provider.packs) {
    assert.match(pack, /## 1\. Task/)
    assert.match(pack, /## 6\. Scope/)
    assert.match(pack, /## 9\. Project card/)
  }
  assert.deepEqual(
    resultAt(out).tasks.map(task => task.status),
    ['done', 'done'],
  )
})

/**
 * A suite whose anchors alone are far bigger than any sane pack budget: three
 * edits into a four-hundred-line file, each shown with its context window.
 */
function oversizedSuite(t) {
  return makeSuite(t, {
    fixture: { 'big.js': Array.from({ length: 400 }, (_, i) => `const line${i} = ${i}`).join('\n') },
    tasks: [
      {
        id: 't1',
        title: 'Touch three places in a very large file',
        description: 'One anchor each, in a file of four hundred lines',
        context: [{ path: 'big.js', reason: 'the file as a whole' }],
        edits: [
          { op: 'modify', path: 'big.js', anchor: 'const line40 = 40', change: 'change one' },
          { op: 'modify', path: 'big.js', anchor: 'const line200 = 200', change: 'change two' },
          { op: 'modify', path: 'big.js', anchor: 'const line360 = 360', change: 'change three' },
          { op: 'create', path: 'out-1.js', change: 'create the module' },
        ],
        verify: [{ command: 'node', args: ['--check', 'out-1.js'], kind: 'proves-change' }],
        type: 'modify',
      },
    ],
  })
}

test('a task whose fixed context cannot fit the pack budget is a setup error', async t => {
  // A pack share so small that the task's own anchors cannot fit in it. The run
  // never starts, so there is no result to read and no Worker to have been
  // handed a truncated brief.
  const suite = oversizedSuite(t)

  const errors = []
  const code = await withApiKey(() =>
    runBench({
      allowUnenforced: true,
      suiteDir: suite,
      configPath: candidateConfig({ contextPack: true, packWindowShare: 0.0005 }),
      write: () => {},
      writeError: line => errors.push(line),
    }),
  )

  assert.equal(code, 2, errors.join('\n'))
  assert.match(errors.join('\n'), /split this task or narrow its context/)
})

test('the pack budget check is skipped entirely while the pack is off', async t => {
  // The same suite and the same tiny share, with contextPack off: the check must
  // not fire, because no pack is built and no budget applies.
  const suite = oversizedSuite(t)
  const out = outPath(t)
  const provider = workerProvider()
  t.after(() => provider.restore())

  const errors = []
  const code = await withApiKey(() =>
    runBench({
      allowUnenforced: true,
      suiteDir: suite,
      configPath: candidateConfig({ packWindowShare: 0.0005 }),
      out,
      write: () => {},
      writeError: line => errors.push(line),
    }),
  )

  assert.notEqual(code, 2, errors.join('\n'))
})
