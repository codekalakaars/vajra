import type { TestTarget } from './target.js'

// The verdict contract (docs/adr/0007-test-verdict-contract.md). Every verification
// path in Vajra terminates here: the Manager never sees raw runner output, only a
// structured verdict and whether it satisfied the task.
//
// The contract exists because Phase One deliberately manufactures failing tests,
// so "failed" is not one state. A test that fails on an assertion has succeeded;
// a test that errors on import has failed, and the fix is in the stub. Collapsing
// those two into a boolean lets a broken Phase One pass the gate.

export type TestVerdict =
  /** The behaviour matched the criterion. */
  | 'passed'
  /** Real failure: the behaviour does not match the criterion. */
  | 'failed_assertion'
  /** Could not run: import error, syntax error, missing export. */
  | 'failed_environment'
  /** The test did not execute — not collected, skipped, or never reached. */
  | 'not_collected'
  /** A file outside the task's declared scope was modified. */
  | 'scope_violation'
  /** The verdict changed across reruns. */
  | 'flaky'
  /** The task exceeded its time budget. */
  | 'timeout'

export type ExpectedOutcome = 'pass' | 'fail_on_assertion'

export type PhaseOneKind = 'stub' | 'test'

/** `mutation` asks whether the tests would catch a seeded defect at all. */
export type CriterionType = 'test' | 'assertion' | 'review' | 'mutation'

export interface SuccessCriterion {
  id: string
  type: CriterionType
}

export interface TaskLike {
  id: string
  phase: number
  kind?: PhaseOneKind
  targetFiles: string[]
  successCriteria: SuccessCriterion[]
}

export interface TestOutcome {
  id: string
  /** The selector the runner was invoked with — a path, a probe id. */
  ref: string
  /** What the case exercises — not necessarily a file. */
  target: TestTarget
  verdict: TestVerdict
  message: string
  location?: { file: string; line: number }
}

export type DiagnosticKind =
  | 'missing_export'
  | 'unresolved_import'
  | 'syntax_error'
  | 'timeout'
  | 'ambiguous'

export interface Diagnostic {
  kind: DiagnosticKind
  message: string
  /** The reference the problem is in, when it is not one of the task's own. */
  ref?: string
  /**
   * The task that can actually fix the problem, when it is not the task under
   * test. A test failing to import an export from a stub is the stub's defect.
   */
  attributedTo?: string
}

export interface VerificationResult {
  taskId: string
  phase: number
  kind?: PhaseOneKind
  expected: ExpectedOutcome
  observed: TestVerdict
  /** The only field the Manager acts on. */
  satisfied: boolean
  tests: TestOutcome[]
  diagnostics: Diagnostic[]
  durationMs: number
  cached: boolean
}

/**
 * A Phase One test task is satisfied by a test that fails on an assertion —
 * that is the gate doing its job. Everything else, including a Phase One stub,
 * is satisfied only by an outright pass.
 */
export function expectedOutcome(task: TaskLike): ExpectedOutcome {
  if (task.phase === 1 && task.kind === 'test') return 'fail_on_assertion'
  return 'pass'
}

/**
 * Verdicts that never satisfy a task, in any phase. A flaky or timed-out result
 * is an absence of signal, not evidence — including in Phase One, where a flaky
 * test has not demonstrated that the behaviour is missing.
 */
const NEVER_SATISFIES: ReadonlySet<TestVerdict> = new Set<TestVerdict>([
  'flaky',
  'timeout',
])

export function isSatisfied(
  expected: ExpectedOutcome,
  observed: TestVerdict,
): boolean {
  if (NEVER_SATISFIES.has(observed)) return false
  return expected === 'pass'
    ? observed === 'passed'
    : observed === 'failed_assertion'
}

/**
 * Rollup severity, worst last. The overall verdict is the worst individual
 * result, because a single unusable test undermines the signal from the rest:
 * one assertion failure among five passing tests is a different situation from
 * one assertion failure among five tests that could not run.
 */
const SEVERITY: Record<TestVerdict, number> = {
  passed: 0,
  failed_assertion: 1,
  flaky: 2,
  not_collected: 3,
  failed_environment: 4,
  scope_violation: 5,
  timeout: 6,
}

export function worse(a: TestVerdict, b: TestVerdict): TestVerdict {
  return SEVERITY[b] > SEVERITY[a] ? b : a
}

/**
 * An empty run is not a pass. A task that declares test criteria but produced
 * no results must not verify green — that is the failure mode where a runner
 * silently collects nothing and every check reports success.
 */
export function rollup(outcomes: readonly TestOutcome[]): TestVerdict {
  if (outcomes.length === 0) return 'not_collected'
  return outcomes.reduce((acc, o) => worse(acc, o.verdict), 'passed' as TestVerdict)
}
