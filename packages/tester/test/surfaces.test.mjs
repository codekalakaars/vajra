import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const root = join(import.meta.dirname, '..', 'dist')
const {
  SURFACES,
  SURFACES_BY_NAME,
  prerequisitesFor,
  unavailableSurfaces,
  createCliTarget,
  generateComponentTest,
  generateLibraryTest,
  requiredCallbacks,
  classifyTest,
  isSatisfied,
  TestRegistry,
  verifyTask,
} = await import(pathToFileURL(join(root, 'index.js')).href)

// --- surface taxonomy ---

test('every common development surface is classified', () => {
  const names = SURFACES.map((s) => s.name)
  for (const expected of [
    'library', 'cli', 'http-api', 'component', 'page', 'job',
    'queue', 'grpc', 'data', 'migration', 'serverless', 'static', 'infra', 'ai-eval',
  ]) {
    assert.equal(names.includes(expected), true, `missing ${expected}`)
  }
})

test('surfaces reduce to the two mechanisms', () => {
  for (const surface of SURFACES) {
    assert.ok(['spawn', 'codegen'].includes(surface.mechanism), surface.name)
    assert.ok(surface.oracle.length > 0, surface.name)
  }
})

test('a surface needing a database is refused without one', () => {
  // A plan that needs a database should be refused at submission, not fail
  // mysteriously three minutes into a build.
  assert.deepEqual(unavailableSurfaces(['data'], ['toolchain', 'runtime']), ['data'])
  assert.deepEqual(unavailableSurfaces(['data'], ['toolchain', 'runtime', 'database']), [])
})

test('a CLI surface needs nothing but a toolchain', () => {
  assert.deepEqual(unavailableSurfaces(['cli'], ['toolchain']), [])
  assert.equal(unavailableSurfaces(['cli'], []).length, 1)
})

test('prerequisites accumulate across surfaces', () => {
  const needed = prerequisitesFor(['cli', 'component'])
  assert.equal(needed.includes('toolchain'), true)
  assert.equal(needed.includes('browser'), true)
})

test('an unknown surface is treated as unavailable', () => {
  assert.deepEqual(unavailableSurfaces(['nope'], ['toolchain', 'runtime', 'database', 'browser']), ['nope'])
  assert.equal(SURFACES_BY_NAME.get('cli').mechanism, 'spawn')
})

// --- CLI probes, executed for real ---

async function script(dir, name, body) {
  const path = join(dir, name)
  await writeFile(path, body, 'utf8')
  await chmod(path, 0o755)
  return path
}

test('a passing CLI probe reports passed', async () => {
  const target = createCliTarget({
    id: 'sum',
    probes: [
      { id: 'adds', command: ['node', '-e', 'console.log(3)'], expect: { exitCode: 0, stdoutContains: ['3'] } },
    ],
  })
  const result = await target.run({ taskId: 't', testRefs: ['adds'], cwd: '.', timeoutMs: 10_000 })
  assert.equal(result.tests[0].status, 'passed')
})

test('the exit code is asserted first, not just the output', async () => {
  // A command that printed the right thing and exited non-zero has still failed.
  const target = createCliTarget({
    id: 'bad',
    probes: [
      {
        id: 'wrongExit',
        command: ['node', '-e', 'console.log("3"); process.exit(2)'],
        expect: { stdoutContains: ['3'] },
      },
    ],
  })
  const result = await target.run({ taskId: 't', testRefs: ['wrongExit'], cwd: '.', timeoutMs: 10_000 })
  assert.equal(result.tests[0].status, 'failed')
  assert.match(result.tests[0].message, /exit code/)
})

test('a wrong exit code is an assertion failure, so Phase One can pass on it', async () => {
  const target = createCliTarget({
    id: 'stub',
    probes: [
      { id: 'p', command: ['node', '-e', 'process.exit(1)'], expect: { exitCode: 0 } },
    ],
  })
  const result = await target.run({ taskId: 't', testRefs: ['p'], cwd: '.', timeoutMs: 10_000 })
  const verdict = classifyTest(result.tests[0]).verdict
  assert.equal(verdict, 'failed_assertion')
  assert.equal(isSatisfied('fail_on_assertion', verdict), true)
})

test('a command that cannot be spawned is an environment failure', async () => {
  const target = createCliTarget({
    id: 'missing',
    probes: [{ id: 'p', command: ['definitely-not-a-real-binary-xyz'], expect: {} }],
  })
  const result = await target.run({ taskId: 't', testRefs: ['p'], cwd: '.', timeoutMs: 5_000 })
  assert.equal(classifyTest(result.tests[0]).verdict, 'failed_environment')
  assert.equal(isSatisfied('fail_on_assertion', classifyTest(result.tests[0]).verdict), false)
})

test('a failed build fails every probe as an environment problem', async () => {
  const target = createCliTarget({
    id: 'b',
    build: [['node', '-e', 'process.exit(1)']],
    probes: [
      { id: 'a', command: ['node', '-e', 'console.log(1)'], expect: {} },
      { id: 'b', command: ['node', '-e', 'console.log(2)'], expect: {} },
    ],
  })
  const result = await target.run({ taskId: 't', testRefs: ['a', 'b'], cwd: '.', timeoutMs: 10_000 })
  assert.equal(result.tests.length, 2)
  for (const t of result.tests) assert.equal(classifyTest(t).verdict, 'failed_environment')
})

test('a hanging command times out rather than hanging the run', async () => {
  const target = createCliTarget({
    id: 'hang',
    probes: [{ id: 'p', command: ['node', '-e', 'setTimeout(()=>{},60000)'], expect: {}, timeoutMs: 400 }],
  })
  const result = await target.run({ taskId: 't', testRefs: ['p'], cwd: '.', timeoutMs: 400 })
  assert.equal(result.tests[0].failureKind, 'environment')
  assert.match(result.tests[0].message, /timed out/)
})

test('a real shell script is probed on exit code, stdout and files produced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vajra-cli-'))
  try {
    const sh = await script(dir, 'greet.sh', `#!/bin/sh
if [ "$1" = "ada" ]; then
  echo "hello ada" > "$2"
  echo "greeted ada"
  exit 0
fi
echo "unknown: $1" >&2
exit 3
`)
    const target = createCliTarget({
      id: 'greet',
      probes: [
        {
          id: 'known',
          command: ['sh', sh, 'ada', join(dir, 'out.txt')],
          expect: {
            exitCode: 0,
            stdoutContains: ['greeted ada'],
            files: [{ path: 'out.txt', contains: ['hello ada'] }],
          },
        },
        {
          id: 'unknown',
          command: ['sh', sh, 'bob'],
          expect: { exitCode: 0, stderrContains: ['unknown: bob'] },
        },
      ],
    })
    const result = await target.run({ taskId: 't', testRefs: ['known', 'unknown'], cwd: dir, timeoutMs: 10_000 })
    assert.equal(result.tests[0].status, 'passed', result.tests[0].message)
    // 'unknown' exits 3 while the probe expects 0 — a real assertion failure.
    assert.equal(result.tests[1].status, 'failed')
    assert.match(result.tests[1].message, /exit code: expected 0, got 3/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a CLI task verifies through the real verifier', async () => {
  const target = createCliTarget({
    id: 'sum',
    probes: [{ id: 'ok', command: ['node', '-e', 'console.log(7)'], expect: { stdout: '7' } }],
  })
  const registry = new TestRegistry()
  registry.register({ ref: 'ok', taskId: 'impl', phase: 2 })
  const result = await verifyTask(
    { id: 'impl', phase: 2, targetFiles: [], successCriteria: [{ id: 'c', type: 'test' }] },
    { registry, runner: target },
  )
  assert.equal(result.satisfied, true)
  assert.equal(result.observed, 'passed')
})

// --- component generation ---

const loginSpec = {
  framework: 'react',
  module: './LoginForm',
  exportName: 'LoginForm',
  cases: [
    {
      name: 'renders the submit control',
      renders: ['Sign in'],
      queries: [{ role: 'button', name: 'Sign in' }],
    },
    {
      name: 'submits the credentials',
      props: { user: 'ada' },
      interactions: [
        { on: { role: 'button', name: 'Sign in' }, expectEvent: 'onSubmit', withArgs: ['ada'] },
      ],
      thenRenders: ['Signing in'],
    },
  ],
}

test('a react component test renders, queries by role, and fires a callback', () => {
  const out = generateComponentTest(loginSpec)
  assert.match(out.contents, /@testing-library\/react/)
  assert.match(out.contents, /import \{ LoginForm \} from '\.\/LoginForm'/)
  assert.match(out.contents, /render\(<LoginForm \{\.\.\.props\} \/>\)/)
  // Queried by accessible role and name, never by class name.
  assert.match(out.contents, /getByRole\("button", \{ name: "Sign in" \}\)/)
  assert.doesNotMatch(out.contents, /className/)
  assert.match(out.contents, /fireEvent\.click/)
  assert.match(out.contents, /toHaveBeenCalledWith\("ada"\)/)
  assert.deepEqual(out.requiredCallbacks, ['onSubmit'])
  assert.deepEqual(out.runCommand, ['npx', 'vitest', 'run'])
})

test('a component spec is reported for a jest project too', () => {
  const out = generateComponentTest({ ...loginSpec, testRunner: 'jest' })
  assert.match(out.contents, /@jest\/globals/)
  assert.deepEqual(out.runCommand, ['npx', 'jest'])
})

test('a callback prop becomes a real spy call, not a spy string', () => {
  // The string "vi.fn()" would parse cleanly and then fail for an unrelated
  // reason, which is the worst kind of generated-code bug.
  for (const framework of ['react', 'vue', 'svelte']) {
    const out = generateComponentTest({ ...loginSpec, framework })
    assert.match(out.contents, /onSubmit: vi\.fn\(\)/, framework)
    assert.doesNotMatch(out.contents, /onSubmit: "vi\.fn\(\)"/, framework)
  }
})

test('the same case generates working code for each framework', () => {
  const cases = [
    { framework: 'vue', expect: [/@vue\/test-utils/, /wrapper\.find\('\[role="button"\]\[aria-label="Sign in"\]'\)\.exists\(\)\)\.toBe\(true\)/, /wrapper\.emitted\("onSubmit"\)/] },
    { framework: 'svelte', expect: [/@testing-library\/svelte/, /getByRole\("button"/, /fireEvent\.click/] },
    { framework: 'angular', expect: [/TestBed\.createComponent/, /el\.textContent\)\.toContain\("Sign in"\)/, /\.click\(\)/] },
  ]
  for (const { framework, expect } of cases) {
    const out = generateComponentTest({ ...loginSpec, framework })
    for (const pattern of expect) {
      assert.match(out.contents, pattern, `${framework}: ${pattern}`)
    }
  }
})

test('generators emit no snapshots and no class selectors', () => {
  // A snapshot records whatever the component currently renders, including
  // whatever is wrong, and then demands a human review the diff.
  for (const framework of ['react', 'vue', 'svelte', 'angular']) {
    const out = generateComponentTest({ ...loginSpec, framework })
    assert.doesNotMatch(out.contents, /toMatchSnapshot|__snapshots__/, framework)
    assert.doesNotMatch(out.contents, /className|\.class\b|class=/, framework)
  }
})

test('a query with no criteria does not generate a bare empty assertion', () => {
  const out = generateComponentTest({
    framework: 'react',
    module: './C',
    exportName: 'C',
    cases: [{ name: 'x', queries: [{}] }],
  })
  // Falls back to a text query rather than emitting getByText("")
  assert.match(out.contents, /getByText\(""\)/)
})

test('a generated test path is derived from the module specifier', () => {
  assert.equal(generateComponentTest(loginSpec).path, './LoginForm.test.ts')
  assert.equal(
    generateComponentTest({ ...loginSpec, module: './forms/LoginForm.tsx' }).path,
    './forms/LoginForm.test.ts',
  )
})

test('required callbacks are collected across all cases', () => {
  assert.deepEqual(
    requiredCallbacks({
      ...loginSpec,
      cases: [
        { name: 'a', interactions: [{ on: { role: 'button' }, expectEvent: 'onSave' }] },
        { name: 'b', interactions: [{ on: { role: 'button' }, expectEvent: 'onCancel' }] },
      ],
    }),
    ['onCancel', 'onSave'],
  )
})

// --- library generation ---

test('a library test is generated per language', () => {
  const expectations = {
    typescript: [/from 'vitest'/, /expect\(/],
    python: [/def test_/, /assert /],
    go: [/func Test/, /t\.Fatal/],
    rust: [/#\[test\]/, /assert_eq!/],
    java: [/@Test/, /assertTrue|assertNotNull/],
    ruby: [/Minitest::Test/, /refute_nil/],
    csharp: [/\[Fact\]/, /Assert\./],
  }
  for (const [language, patterns] of Object.entries(expectations)) {
    const out = generateLibraryTest({
      language,
      path: `./sum.test.${language === 'python' ? 'py' : 'txt'}`,
      imports: language === 'go' ? ['package sum'] : [],
      cases: [{ name: 'adds two numbers', call: 'add(1, 2)', equals: 3 }],
    })
    for (const pattern of patterns) assert.match(out.contents, pattern, `${language}: ${pattern}`)
    assert.ok(out.runCommand.length > 0, language)
  }
})

test('a throwing case generates a raise assertion, not an equality one', () => {
  const py = generateLibraryTest({
    language: 'python',
    path: './t.py',
    cases: [{ name: 'rejects empty', call: 'validate("")', throws: true }],
  })
  assert.match(py.contents, /pytest\.raises/)
  const ts = generateLibraryTest({
    language: 'typescript',
    path: './t.ts',
    cases: [{ name: 'rejects empty', call: 'validate("")', throws: true }],
  })
  assert.match(ts.contents, /toThrow/)
})

test('an explicit assertion expression is used when given', () => {
  const out = generateLibraryTest({
    language: 'python',
    path: './t.py',
    cases: [{ name: 'is positive', call: 'total()', assert: 'total() > 0' }],
  })
  assert.match(out.contents, /assert total\(\) > 0/)
})
