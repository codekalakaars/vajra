import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const { TestRegistry } = await import(pathToFileURL(join(root, 'registry.js')).href)
const { cacheKey, runKey, hashContent, createMemoryCache } = await import(
  pathToFileURL(join(root, 'cache.js')).href
)
const {
  attributeDiagnostics,
  verdictExcludingForeignFailures,
  isMissingExport,
  isUnresolvedImport,
} = await import(pathToFileURL(join(root, 'attribute.js')).href)

// --- registry ---

test('registry binds test files to owning tasks', () => {
  const registry = new TestRegistry()
  registry.register({ ref: 'src/auth.test.ts', taskId: 'stub', phase: 1, kind: 'stub' })
  registry.register({ ref: 'src/auth.test.ts.check', taskId: 'x', phase: 2 })
  assert.equal(registry.ownerOf('src/auth.test.ts'), 'stub')
  assert.deepEqual(registry.testsFor('stub'), ['src/auth.test.ts'])
  assert.equal(registry.testsFor('nope').length, 0)
  assert.equal(registry.size, 2)
})

test('registry reports test files in a deterministic order', () => {
  const registry = new TestRegistry()
  registry.register({ ref: 'z.test.ts', taskId: 't', phase: 1 })
  registry.register({ ref: 'a.test.ts', taskId: 't', phase: 1 })
  assert.deepEqual(registry.testsFor('t'), ['a.test.ts', 'z.test.ts'])
})

// --- cache ---

const keyInput = {
  testHash: hashContent('test body'),
  depHashes: [hashContent('dep a'), hashContent('dep b')],
  globalHash: hashContent('config'),
  runnerVersion: 'v1',
}

test('cache key is stable regardless of dependency order', () => {
  const flipped = { ...keyInput, depHashes: [...keyInput.depHashes].reverse() }
  assert.equal(cacheKey(keyInput), cacheKey(flipped))
})

test('cache key changes when anything relevant changes', () => {
  const base = cacheKey(keyInput)
  assert.notEqual(base, cacheKey({ ...keyInput, testHash: hashContent('other') }))
  assert.notEqual(base, cacheKey({ ...keyInput, globalHash: hashContent('other') }))
  assert.notEqual(base, cacheKey({ ...keyInput, runnerVersion: 'v2' }))
  assert.notEqual(
    base,
    cacheKey({ ...keyInput, depHashes: [hashContent('dep a')] }),
    'dropping a dependency must invalidate',
  )
})

test('a runner version bump invalidates cached verdicts', () => {
  // The adapter's output shape is part of the key, so a shape change cannot
  // silently reuse verdicts parsed under the old shape.
  const a = runKey([{ testHash: 'h', depHashes: [] }], 'g', 'v1')
  const b = runKey([{ testHash: 'h', depHashes: [] }], 'g', 'v2')
  assert.notEqual(a, b)
})

test('memory cache round-trips', () => {
  const cache = createMemoryCache()
  const result = { taskId: 't', satisfied: true }
  assert.equal(cache.get('k'), undefined)
  cache.set('k', result)
  assert.equal(cache.get('k'), result)
})

// --- attribution ---

test('recognises missing-export and unresolved-import messages', () => {
  assert.equal(isMissingExport("does not provide an export named 'validateUser'"), true)
  assert.equal(isMissingExport("Module 'x' has no exported member 'y'"), true)
  assert.equal(isMissingExport('something else entirely'), false)
  assert.equal(isUnresolvedImport("Cannot find module './gone.js'"), true)
})

test('a diagnostic on a foreign file is attributed to the owning task', () => {
  // The whole point: a test failing to import a stub's export is the stub's
  // defect, and reporting it as a test defect sends the Developer to the wrong
  // task.
  const diagnostics = attributeDiagnostics(
    [{ kind: 'missing_export', message: 'no export', ref: 'src/auth.ts' }],
    [],
    ['src/auth.test.ts'],
    (file) => (file === 'src/auth.ts' ? 'task_stub' : undefined),
  )
  assert.equal(diagnostics[0].attributedTo, 'task_stub')
})

test('a diagnostic on the task\'s own file is not reassigned', () => {
  const diagnostics = attributeDiagnostics(
    [{ kind: 'syntax_error', message: 'bad', ref: 'src/auth.ts' }],
    [],
    ['src/auth.ts'],
    () => 'other',
  )
  assert.equal(diagnostics[0].attributedTo, undefined)
})

test('a foreign environment failure does not condemn the task', () => {
  // A task is not responsible for pre-existing breakage elsewhere.
  const tests = [
    { id: '1', target: { kind: 'file', ref: 'src/auth.test.ts' }, verdict: 'passed', message: '' },
    {
      id: '2',
      target: { kind: 'file', ref: 'other.test.ts' },
      verdict: 'failed_environment',
      message: 'missing export',
    },
  ]
  const { verdict, foreign } = verdictExcludingForeignFailures(tests, ['src/auth.test.ts'])
  assert.equal(verdict, 'passed')
  assert.equal(foreign.length, 1)
})

test('a failure inside the task still condemns it', () => {
  const tests = [
    { id: '1', target: { kind: 'file', ref: 'src/auth.test.ts' }, verdict: 'failed_assertion', message: '' },
  ]
  const { verdict, foreign } = verdictExcludingForeignFailures(tests, ['src/auth.test.ts'])
  assert.equal(verdict, 'failed_assertion')
  assert.equal(foreign.length, 0)
})

test('a task with only foreign failures reports not_collected, not passed', () => {
  const tests = [
    { id: '1', target: { kind: 'file', ref: 'other.test.ts' }, verdict: 'failed_environment', message: '' },
  ]
  const { verdict } = verdictExcludingForeignFailures(tests, ['src/auth.test.ts'])
  assert.equal(verdict, 'not_collected')
})
