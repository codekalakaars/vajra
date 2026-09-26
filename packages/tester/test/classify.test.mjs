import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const { classifyTest, classifyRun } = await import(
  pathToFileURL(join(root, 'classify.js')).href
)

const raw = (over = {}) => ({
  id: 't',
  target: { kind: 'file', ref: 'src/auth.test.ts' },
  status: 'failed',
  failureKind: 'assertion',
  message: 'expected true, got false',
  ...over,
})

test('a passed test is passed', () => {
  assert.equal(classifyTest(raw({ status: 'passed', failureKind: undefined })).verdict, 'passed')
})

test('an assertion failure is failed_assertion', () => {
  const { verdict, diagnostics } = classifyTest(raw())
  assert.equal(verdict, 'failed_assertion')
  assert.equal(diagnostics.length, 0)
})

test('an errored test is failed_environment', () => {
  const { verdict, diagnostics } = classifyTest(
    raw({ status: 'errored', failureKind: undefined, message: 'SyntaxError: bad' }),
  )
  assert.equal(verdict, 'failed_environment')
  assert.equal(diagnostics[0].kind, 'syntax_error')
})

test('skipped and not-run are not_collected', () => {
  assert.equal(classifyTest(raw({ status: 'skipped', failureKind: undefined })).verdict, 'not_collected')
  assert.equal(classifyTest(raw({ status: 'not_run', failureKind: undefined })).verdict, 'not_collected')
})

test('an unclassifiable failure resolves conservatively, not optimistically', () => {
  // A runner that cannot tell assertion from environment must not have its
  // ambiguity guessed as a plain failure — that would let a broken Phase One
  // through the gate. It resolves to failed_environment and says so.
  const { verdict, diagnostics } = classifyTest(raw({ failureKind: undefined }))
  assert.equal(verdict, 'failed_environment')
  assert.equal(diagnostics[0].kind, 'ambiguous')
})

test('error messages are classified by kind', () => {
  const kind = (message) => classifyTest(raw({ status: 'errored', failureKind: undefined, message })).diagnostics[0].kind
  assert.equal(kind("Cannot find module './missing.js'"), 'unresolved_import')
  assert.equal(kind("Failed to resolve import './x.js'"), 'unresolved_import')
  assert.equal(kind("does not provide an export named 'validateUser'"), 'missing_export')
  assert.equal(kind("Module has no exported member 'validateUser'"), 'missing_export')
})

test('an expected test file that produced no outcome is not_collected', () => {
  // Guards against a runner that silently drops a file: missing must not look
  // the same as clean.
  const result = classifyRun(
    { tests: [{ id: 'a', ref: 'a.test.ts', target: { kind: 'file', ref: 'a.test.ts' }, status: 'passed' }], durationMs: 1 },
    { expectedRefs: ['a.test.ts', 'b.test.ts'] },
  )
  const b = result.tests.find((t) => t.target.ref === 'b.test.ts')
  assert.equal(b.verdict, 'not_collected')
  assert.equal(result.verdict, 'not_collected')
})

test('a timed-out run is a timeout regardless of individual results', () => {
  const result = classifyRun({
    tests: [{ id: 'a', ref: 'a.test.ts', target: { kind: 'file', ref: 'a.test.ts' }, status: 'passed' }],
    durationMs: 999,
    timedOut: true,
  })
  assert.equal(result.verdict, 'timeout')
  assert.equal(result.diagnostics.some((d) => d.kind === 'timeout'), true)
})

test('a clean run of every expected file is passed', () => {
  const result = classifyRun(
    {
      tests: [
        { id: 'a', ref: 'a.test.ts', target: { kind: 'file', ref: 'a.test.ts' }, status: 'passed' },
        { id: 'b', ref: 'b.test.ts', target: { kind: 'file', ref: 'b.test.ts' }, status: 'passed' },
      ],
      durationMs: 5,
    },
    { expectedRefs: ['a.test.ts', 'b.test.ts'] },
  )
  assert.equal(result.verdict, 'passed')
  assert.equal(result.tests.length, 2)
})
