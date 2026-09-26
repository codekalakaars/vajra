import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const root = join(import.meta.dirname, '..', 'dist')
const {
  createGraphResolver,
  createMultiResolver,
  createOpaqueResolver,
  buildModuleGraph,
  fileTarget,
  testId,
  isFileTarget,
} = await import(pathToFileURL(join(root, 'index.js')).href)
const { createCommandRunner } = await import(pathToFileURL(join(root, 'command.js')).href)
const { createFsHasher } = await import(pathToFileURL(join(root, 'hasher.js')).href)

// --- targets ---

test('a test target is a kind plus a stable reference', () => {
  assert.equal(fileTarget('src/auth.ts').kind, 'file')
  assert.equal(isFileTarget(fileTarget('x')), true)
  assert.equal(isFileTarget({ kind: 'http', ref: '/login' }), false)
})

test('test ids stay unique across ecosystems sharing a method name', () => {
  const a = testId({ kind: 'file', ref: 'tests/test_login.py' }, 'test_login')
  const b = testId({ kind: 'suite', ref: 'com.example.AuthTest' }, 'test_login')
  assert.notEqual(a, b)
})

// --- resolvers ---

const jsGraph = () =>
  buildModuleGraph([
    { file: 'src/auth.ts', imports: [] },
    { file: 'src/auth.test.ts', imports: ['./auth'] },
  ])

test('a graph resolver selects through the module graph', () => {
  const resolver = createGraphResolver(jsGraph())
  assert.deepEqual(resolver.testsFor(['src/auth.ts']), ['src/auth.test.ts'])
  assert.equal(resolver.language, 'javascript')
})

test('resolvers combine across languages', () => {
  // A task touching a TypeScript file and a Rust module must select tests
  // from both ecosystems, which the first implementation could not do.
  const rust = createOpaqueResolver('rust', ['src/auth_test.rs'], 'proc-macro expansion')
  const multi = createMultiResolver([createGraphResolver(jsGraph()), rust])
  assert.equal(multi.language, 'javascript+rust')
  assert.deepEqual(multi.testsFor(['src/auth.ts']), ['src/auth.test.ts', 'src/auth_test.rs'])
})

test('an opaque resolver over-reports rather than silently dropping coverage', () => {
  // Returning nothing would look identical to "no tests are affected" and the
  // affected tests would quietly never run.
  const resolver = createOpaqueResolver('python', ['tests/test_a.py'], 'dynamic import')
  assert.deepEqual(resolver.testsFor(['anything']), ['tests/test_a.py'])
  assert.deepEqual(resolver.unmodelled(), ['dynamic import'])
})

// --- command runner: the actual "any language" path ---

const junitReport = `<testsuites><testsuite name="rs" tests="2">
  <testcase classname="auth::tests" name="test_login"><failure message="assert failed"/></testcase>
  <testcase classname="auth::tests" name="test_logout"/>
</testsuite></testsuites>`

test('a command runner ingests a junit report from any language', async () => {
  const seen = []
  const runner = createCommandRunner(
    { command: ['cargo', 'test', '--'], report: { format: 'junit' } },
    { exec: async (argv) => (seen.push(argv), { stdout: junitReport, code: 0, signal: null }) },
  )
  const result = await runner.run({ taskId: 't', testRefs: ['auth::tests'], cwd: '.', timeoutMs: 1000 })
  assert.equal(result.tests.length, 2)
  assert.equal(result.tests[0].status, 'failed')
  assert.equal(result.tests[0].failureKind, 'assertion')
  assert.deepEqual(seen[0], ['cargo', 'test', '--', 'auth::tests'])
})

test('a report the runner cannot produce is an environment failure, not a pass', async () => {
  // A crashed test binary must never look like a clean run.
  const runner = createCommandRunner(
    { command: ['go', 'test'], report: { format: 'junit' } },
    { exec: async () => ({ stdout: 'panic: runtime error', code: 2, signal: null }) },
  )
  const result = await runner.run({ taskId: 't', testRefs: [], cwd: '.', timeoutMs: 1000 })
  assert.equal(result.tests[0].status, 'errored')
  assert.match(result.tests[0].message, /could not parse a test report/)
})

test('a command that cannot be spawned is an environment failure', async () => {
  const runner = createCommandRunner(
    { command: ['nope'], report: { format: 'junit' } },
    { exec: async () => { throw new Error('ENOENT') } },
  )
  const result = await runner.run({ taskId: 't', testRefs: [], cwd: '.', timeoutMs: 1000 })
  assert.equal(result.tests[0].status, 'errored')
  assert.match(result.tests[0].message, /could not run/)
})

test('a killed command is reported as timed out', async () => {
  const runner = createCommandRunner(
    { command: ['x'], report: { format: 'junit' } },
    { exec: async () => ({ stdout: junitReport, code: null, signal: 'SIGKILL' }) },
  )
  const result = await runner.run({ taskId: 't', testRefs: [], cwd: '.', timeoutMs: 1000 })
  assert.equal(result.timedOut, true)
})

test('a report is read from a file when one is configured', async () => {
  const runner = createCommandRunner(
    { command: ['pytest'], reportPath: '/tmp/report.xml', report: { format: 'junit' } },
    {
      exec: async () => ({ stdout: '', code: 0, signal: null }),
      readFile: async () => junitReport,
    },
  )
  const result = await runner.run({ taskId: 't', testRefs: [], cwd: '.', timeoutMs: 1000 })
  assert.equal(result.tests.length, 2)
})

// --- hasher ---

test('the fs hasher hashes contents and distinguishes a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vajra-tester-'))
  try {
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src/a.ts'), 'export const a = 1')
    const hasher = createFsHasher(dir)
    const h1 = await hasher.hashFile('src/a.ts')
    const h2 = await hasher.hashFile('src/a.ts')
    assert.equal(h1, h2)
    assert.notEqual(h1, await hasher.hashFile('src/absent.ts'))

    await writeFile(join(dir, 'src/a.ts'), 'export const a = 2')
    assert.notEqual(h1, await hasher.hashFile('src/a.ts'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a combined global hash is order independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vajra-tester-'))
  try {
    await writeFile(join(dir, 'c1'), 'a')
    await writeFile(join(dir, 'c2'), 'b')
    const hasher = createFsHasher(dir)
    assert.equal(
      await hasher.hashFiles(['c1', 'c2']),
      await hasher.hashFiles(['c2', 'c1']),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
