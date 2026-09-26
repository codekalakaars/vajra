// Cross-task attribution.
//
// A Phase One failure is frequently caused by a different task than the one
// under test. The common case: a stub does not export a symbol its test
// imports, so the test errors on import and appears to fail for the wrong
// reason. Reported naively, every stub defect surfaces as a test defect and the
// Developer debugs the wrong task.
//
// This rewrites those diagnostics to point at the task that can fix them.

import type { Diagnostic, TestOutcome, TestVerdict } from './verdict.js'

const MISSING_EXPORT_PATTERNS: readonly RegExp[] = [
  /does not provide an export named ['"]?([A-Za-z0-9_$]+)['"]?/,
  /has no exported member ['"]?([A-Za-z0-9_$]+)['"]?/,
  /is not exported from/,
  /Module ['"].+['"] has no exported/,
]

const UNRESOLVED_IMPORT_PATTERNS: readonly RegExp[] = [
  /Cannot find module ['"]([^'"]+)['"]/,
  /failed to resolve import ["']([^'"]+)["']/,
  /Unable to resolve ["']([^'"]+)["']/,
]

function matchesAny(patterns: readonly RegExp[], message: string): boolean {
  return patterns.some((pattern) => pattern.test(message))
}

/**
 * A diagnostic points at a reference that is not one of the task's own. If
 * that reference belongs to another task, the other task is the one that can
 * fix it — a Phase One test failing to import a stub's export is the stub's
 * defect, not the test's.
 */
export function attributeDiagnostics(
  diagnostics: readonly Diagnostic[],
  tests: readonly TestOutcome[],
  ownRefs: readonly string[],
  ownerOf: (ref: string) => string | undefined,
): Diagnostic[] {
  const own = new Set(ownRefs)
  return diagnostics.map((diagnostic) => {
    if (diagnostic.attributedTo || !diagnostic.ref || own.has(diagnostic.ref)) {
      return diagnostic
    }
    const owner = ownerOf(diagnostic.ref)
    return owner ? { ...diagnostic, attributedTo: owner } : diagnostic
  })
}

/**
 * The verdict a task should be judged on, once collateral damage elsewhere is
 * separated out. A task is not responsible for pre-existing breakage, so an
 * environment failure caused by another task's stub must not condemn it — but
 * the diagnostic has to survive, or the real defect goes unreported.
 */
export function verdictExcludingForeignFailures(
  tests: readonly TestOutcome[],
  ownRefs: readonly string[],
): { verdict: TestVerdict; foreign: TestOutcome[] } {
  const own = new Set(ownRefs)
  const mine: TestOutcome[] = []
  const foreign: TestOutcome[] = []

  for (const test of tests) {
    if (test.verdict === 'failed_environment' && !own.has(test.target.ref)) {
      foreign.push(test)
    } else {
      mine.push(test)
    }
  }

  if (mine.length === 0) {
    return { verdict: 'not_collected', foreign }
  }
  const verdict = mine.reduce<TestVerdict>(
    (acc, t) => (severity(t.verdict) > severity(acc) ? t.verdict : acc),
    'passed',
  )
  return { verdict, foreign }
}

const ORDER: Record<TestVerdict, number> = {
  passed: 0,
  failed_assertion: 1,
  flaky: 2,
  not_collected: 3,
  failed_environment: 4,
  scope_violation: 5,
  timeout: 6,
}

function severity(verdict: TestVerdict): number {
  return ORDER[verdict]
}

export function isMissingExport(message: string): boolean {
  return matchesAny(MISSING_EXPORT_PATTERNS, message)
}

export function isUnresolvedImport(message: string): boolean {
  return matchesAny(UNRESOLVED_IMPORT_PATTERNS, message)
}
