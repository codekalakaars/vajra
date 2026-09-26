// Composition: task in, VerificationResult out.
//
// This is the only surface the Manager talks to. It selects the tests a task
// declared, runs them, classifies the outcome, inverts the expectation for
// Phase One, and attributes collateral damage back to whoever can fix it.
// It never interprets raw runner output itself.

import { attributeDiagnostics, verdictExcludingForeignFailures } from './attribute.js'
import { runKey, type VerdictCache } from './cache.js'
import { classifyRun } from './classify.js'
import { detectFlake, type FlakeHistory } from './flake.js'
import type { ModuleGraph } from './graph.js'
import { hasTestCriteria, type RunnerAdapter } from './runner.js'
import type { TestRegistry } from './registry.js'
import {
  expectedOutcome,
  isSatisfied,
  type Diagnostic,
  type TaskLike,
  type TestOutcome,
  type VerificationResult,
} from './verdict.js'

export const DEFAULT_TIMEOUT_MS = 120_000

export interface ContentHasher {
  hashFile(file: string): Promise<string>
  hashFiles(files: readonly string[]): Promise<string>
}

export interface VerifierDeps {
  registry: TestRegistry
  runner: RunnerAdapter
  graph?: ModuleGraph
  cache?: VerdictCache
  flakes?: FlakeHistory
  hasher?: ContentHasher
  cwd?: string
  timeoutMs?: number
  reruns?: number
  envFingerprint?: string
  /** Test files whose contents invalidate every cached result. */
  globalFiles?: readonly string[]
}

export interface VerifyOptions {
  /** Skip the cache and force a run. */
  fresh?: boolean
  /** Suppress rerun-based flake detection. */
  noFlakeDetection?: boolean
}

export async function verifyTask(
  task: TaskLike,
  deps: VerifierDeps,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const testRefs = deps.registry.testsFor(task.id)
  const expected = expectedOutcome(task)

  if (testRefs.length === 0) {
    // A task with nothing to run is only legitimate if it asks for nothing
    // mechanical. Anything else is an empty run, which must not read as a pass.
    if (!hasTestCriteria(task)) {
      return result(task, expected, 'passed', [], [], 0, false)
    }
    return result(task, expected, 'not_collected', [], [
      {
        kind: 'unresolved_import',
        message: 'task declares test criteria but no test file is bound to it',
      },
    ], 0, false)
  }

  const key = await computeRunKey(task, testRefs, deps, options.fresh)
  if (key && deps.cache) {
    const hit = deps.cache.get(key)
    if (hit) return { ...hit, cached: true }
  }

  const request = {
    taskId: task.id,
    testRefs,
    cwd: deps.cwd ?? process.cwd(),
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }

  const detection = options.noFlakeDetection
    ? await (async () => {
        const result = await deps.runner.run(request)
        const classified = classifyRun(result, { expectedRefs: testRefs })
        return {
          verdict: classified.verdict,
          attempts: [classified.verdict],
          runs: 1,
          final: classified,
        }
      })()
    : await detectFlake(request, deps.runner, deps.reruns, { expectedRefs: testRefs })

  const classified = detection.final
  const tests: TestOutcome[] = classified.tests

  for (const test of tests) {
    deps.flakes?.record(test.id, detection.verdict === 'flaky')
  }

  const own = new Set(task.targetFiles)
  const { verdict: scoped, foreign } = verdictExcludingForeignFailures(tests, [...own])
  const observed = detection.verdict === 'flaky' ? 'flaky' : scoped

  const diagnostics: Diagnostic[] = attributeDiagnostics(
    [...classified.diagnostics, ...foreign.map(toDiagnostic)],
    tests,
    task.targetFiles,
    (ref) => deps.registry.resolveOwner([ref]),
  )

  const final = result(task, expected, observed, tests, diagnostics, classified.durationMs, false)
  if (key && deps.cache) deps.cache.set(key, final)
  return final
}

function toDiagnostic(test: TestOutcome): Diagnostic {
  return {
    kind: 'syntax_error',
    message: `${test.target.ref}: ${test.message || 'failed to run'}`,
    ref: test.target.ref,
  }
}

async function computeRunKey(
  task: TaskLike,
  testRefs: readonly string[],
  deps: VerifierDeps,
  fresh?: boolean,
): Promise<string | undefined> {
  if (!deps.hasher || fresh) return undefined
  const globalHash = await deps.hasher.hashFiles(deps.globalFiles ?? [])
  const inputs = await Promise.all(
    testRefs.map(async (ref) => ({
      testHash: await deps.hasher!.hashFile(ref),
      depHashes: [] as string[],
    })),
  )
  return runKey(inputs, globalHash, deps.runner.version, deps.envFingerprint)
}

function result(
  task: TaskLike,
  expected: ReturnType<typeof expectedOutcome>,
  observed: VerificationResult['observed'],
  tests: TestOutcome[],
  diagnostics: Diagnostic[],
  durationMs: number,
  cached: boolean,
): VerificationResult {
  return {
    taskId: task.id,
    phase: task.phase,
    ...(task.kind ? { kind: task.kind } : {}),
    expected,
    observed,
    satisfied: isSatisfied(expected, observed),
    tests,
    diagnostics,
    durationMs,
    cached,
  }
}

/**
 * The global invariant: at rest, every test passes. Per-task verification
 * structurally cannot catch a task that verified green while something else
 * was already broken, so this checks the whole suite.
 */
export function atRestViolations(
  results: readonly VerificationResult[],
): VerificationResult[] {
  return results.filter((r) => r.expected === 'pass' && r.observed !== 'passed')
}
