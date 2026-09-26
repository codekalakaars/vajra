import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const { TestRegistry } = await import(pathToFileURL(join(root, 'registry.js')).href)
const { verifyTask, atRestViolations } = await import(
  pathToFileURL(join(root, 'verifier.js')).href
)
const { createMemoryCache } = await import(pathToFileURL(join(root, 'cache.js')).href)

/**
 * A fake adapter stands in for a real test runner. Everything upstream of the
 * runner interface is pure, so the whole verification path is exercisable here
 * without spawning anything — which is the isolation the design is for.
 */
function fakeRunner(script) {
  const calls = []
  let n = 0
  return {
    name: 'fake',
    version: 'v1',
    calls,
    async run(request) {
      calls.push(request)
      n += 1
      return script(request, n)
    },
  }
}

const passed = (files) => (request) => ({
  tests: request.testRefs.map((f) => ({ id: f, ref: f, target: { kind: 'file', ref: f }, status: 'passed' })),
  durationMs: 1,
})

const failedAssertion = (files) => (request) => ({
  tests: request.testRefs.map((f) => ({
    id: f,
    ref: f,
    target: { kind: 'file', ref: f },
    status: 'failed',
    failureKind: 'assertion',
    message: 'expected true, got false',
  })),
  durationMs: 1,
})

function setup(bindings, runner, extra = {}) {
  const registry = new TestRegistry()
  for (const b of bindings) registry.register(b)
  return { registry, runner, ...extra }
}

const stubTask = {
  id: 'stub_auth',
  phase: 1,
  kind: 'stub',
  targetFiles: ['src/auth.ts'],
  successCriteria: [{ id: 'c', type: 'test' }],
}

const testTask = {
  id: 'test_auth',
  phase: 1,
  kind: 'test',
  targetFiles: ['src/auth.test.ts'],
  successCriteria: [{ id: 'c', type: 'test' }],
}

const implTask = {
  id: 'impl_auth',
  phase: 2,
  targetFiles: ['src/auth.ts'],
  successCriteria: [{ id: 'c', type: 'test' }],
}

// --- the gate ---

test('a Phase One test that fails on an assertion satisfies its task', async () => {
  const deps = setup(
    [{ ref: 'src/auth.test.ts', taskId: 'test_auth', phase: 1, kind: 'test' }],
    fakeRunner(failedAssertion()),
  )
  const result = await verifyTask(testTask, deps)
  assert.equal(result.expected, 'fail_on_assertion')
  assert.equal(result.observed, 'failed_assertion')
  assert.equal(result.satisfied, true)
})

test('a Phase One test that errors on import does NOT satisfy its task', async () => {
  // The trap. An import error looks like a failing test, and accepting it would
  // let a broken stub through the gate.
  const runner = fakeRunner((request) => ({
    tests: request.testRefs.map((f) => ({
      id: f,
      ref: f,
      target: { kind: 'file', ref: f },
      status: 'errored',
      message: "does not provide an export named 'validateUser'",
    })),
    durationMs: 1,
  }))
  const deps = setup(
    [{ ref: 'src/auth.test.ts', taskId: 'test_auth', phase: 1, kind: 'test' }],
    runner,
  )
  const result = await verifyTask(testTask, deps)
  assert.equal(result.satisfied, false)
  assert.equal(result.observed, 'failed_environment')
  assert.equal(result.diagnostics.some((d) => d.kind === 'missing_export'), true)
})

test('a Phase One stub that produces a passing check satisfies its task', async () => {
  const deps = setup(
    [{ ref: 'src/auth.test.ts', taskId: 'stub_auth', phase: 1, kind: 'stub' }],
    fakeRunner(passed()),
  )
  const result = await verifyTask(stubTask, deps)
  assert.equal(result.expected, 'pass')
  assert.equal(result.satisfied, true)
})

// --- expectation inversion across phases ---

test('the same failing test satisfies in phase one and fails in phase two', async () => {
  const binding = [{ ref: 'src/auth.test.ts', taskId: 't', phase: 1 }]
  const runner = fakeRunner(failedAssertion())

  const one = await verifyTask({ ...testTask, id: 't' }, setup(binding, runner))
  const two = await verifyTask({ ...implTask, id: 't' }, setup(binding, runner))

  assert.equal(one.expected, 'fail_on_assertion')
  assert.equal(one.satisfied, true)
  assert.equal(two.expected, 'pass')
  assert.equal(two.satisfied, false)
  assert.equal(two.observed, 'failed_assertion')
})

// --- empty and unbound ---

test('a task with no bound test file but with test criteria is not_collected', async () => {
  // Never a pass: a runner that collects nothing must not look clean.
  const deps = setup([], fakeRunner(passed()))
  const result = await verifyTask(testTask, deps)
  assert.equal(result.satisfied, false)
  assert.equal(result.observed, 'not_collected')
})

test('a task asking for no mechanical criteria verifies without running', async () => {
  const runner = fakeRunner(passed())
  const deps = setup([], runner)
  const result = await verifyTask(
    { id: 't', phase: 2, targetFiles: [], successCriteria: [{ id: 'c', type: 'review' }] },
    deps,
  )
  assert.equal(result.satisfied, true)
  assert.equal(runner.calls.length, 0)
})

// --- scope ---

test('a test that never ran is reported, not assumed passing', async () => {
  const runner = fakeRunner((request) => ({
    tests: [{ id: 'a', ref: 'a.test.ts', target: { kind: 'file', ref: 'a.test.ts' }, status: 'passed' }],
    durationMs: 1,
  }))
  const deps = setup(
    [
      { ref: 'a.test.ts', taskId: 't', phase: 2 },
      { ref: 'b.test.ts', taskId: 't', phase: 2 },
    ],
    runner,
  )
  const result = await verifyTask({ ...implTask, id: 't' }, deps)
  assert.equal(result.satisfied, false)
  assert.equal(result.observed, 'not_collected')
})

// --- caching ---

test('a cached result is reused on a second verification', async () => {
  const runner = fakeRunner(passed())
  const deps = setup(
    [{ ref: 'src/auth.test.ts', taskId: 'impl_auth', phase: 2 }],
    runner,
    {
      cache: createMemoryCache(),
      hasher: {
        hashFile: async () => 'h',
        hashFiles: async () => 'g',
      },
    },
  )
  const first = await verifyTask(implTask, deps)
  const second = await verifyTask(implTask, deps)
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(runner.calls.length, 1, 'the runner should not be called twice')
  assert.equal(second.satisfied, first.satisfied)
})

test('fresh skips the cache', async () => {
  const runner = fakeRunner(passed())
  const deps = setup(
    [{ ref: 'src/auth.test.ts', taskId: 'impl_auth', phase: 2 }],
    runner,
    {
      cache: createMemoryCache(),
      hasher: { hashFile: async () => 'h', hashFiles: async () => 'g' },
    },
  )
  await verifyTask(implTask, deps)
  await verifyTask(implTask, deps, { fresh: true })
  assert.equal(runner.calls.length, 2)
})

// --- the at-rest invariant ---

test('at-rest violations surface tasks that should pass but did not', async () => {
  const results = [
    { expected: 'pass', observed: 'passed' },
    { expected: 'pass', observed: 'failed_assertion' },
    { expected: 'fail_on_assertion', observed: 'failed_assertion' },
  ].map((r) => ({ taskId: `${r.observed}`, tests: [], diagnostics: [], durationMs: 0, cached: false, satisfied: false, phase: 2, ...r }))

  const violations = atRestViolations(results)
  // The Phase One test is expected to fail, so it is not a violation.
  assert.equal(violations.length, 1)
  assert.equal(violations[0].observed, 'failed_assertion')
})
