// The seam between Vajra and whatever actually runs the tests.
//
// Everything upstream of this interface is pure and testable with a fake
// adapter; the risky part — whether a real runner exposes enough detail to
// distinguish an assertion failure from an environment error — is confined to
// one adapter. That isolation is deliberate: it is the make-or-break spike in
// docs/testing/README.md, and nothing else should depend on the answer.

import type { TestTarget } from './target.js'
import type { RouteIndex } from './route.js'

export interface RawTestOutcome {
  id: string
  /**
   * The selector this case was invoked by — the file path a file-based runner
   * was given, or the probe id an API target was given. This is what "did the
   * runner actually run what I asked for?" is checked against, and it is
   * deliberately not the same as `target`.
   */
  ref: string
  /** What this case exercises. A file in the common case, but not only that. */
  target: TestTarget
  /**
   * `errored` covers anything that stopped the test body from running:
   * import failure, syntax error, missing export.
   */
  status: 'passed' | 'failed' | 'errored' | 'skipped' | 'not_run'
  message?: string
  location?: { file: string; line: number }
  /**
   * Required when status is `failed`. An adapter that cannot tell the two apart
   * must omit it, which the classifier treats conservatively.
   */
  failureKind?: 'assertion' | 'environment'
}

export interface RawRunResult {
  tests: RawTestOutcome[]
  durationMs: number
  timedOut?: boolean
}

export interface RunRequest {
  taskId: string
  /** Test references to run, as the resolver named them. */
  testRefs: string[]
  cwd: string
  timeoutMs: number
}

export interface RunnerAdapter {
  readonly name: string
  /** Bumped when the adapter's output shape changes. Part of the cache key. */
  readonly version: string
  run(request: RunRequest): Promise<RawRunResult>
}

/**
 * A runner that can say which of its tests a set of changed source files
 * determines. Implemented by API targets, whose probes correspond to routes
 * rather than to imported modules — without it, changing a route handler
 * selects no probes and the change verifies nothing.
 */
export interface RouteAwareRunner extends RunnerAdapter {
  probesForRoutes(routes: RouteIndex, changedFiles: readonly string[]): string[]
  routes: RouteIndex
}

/**
 * Whether a task carries criteria that only running something can settle.
 * A mutation criterion counts: it runs the suite against seeded defects.
 */
export function hasTestCriteria(task: {
  successCriteria: ReadonlyArray<{ type: string }>
}): boolean {
  return task.successCriteria.some(
    (c) => c.type === 'test' || c.type === 'assertion' || c.type === 'mutation',
  )
}
