// Raw runner output → structured verdicts.
//
// The one judgement call here is what to do with a `failed` result whose
// failureKind the adapter could not determine. Guessing either way is wrong: a
// guess of `failed_assertion` lets a broken Phase One through the gate, and a
// guess of `failed_environment` rejects a healthy one. It is resolved by taking
// the conservative option and reporting the ambiguity, because a false failure
// costs one escalation round trip while a false pass costs the whole gate.

import type { RawRunResult, RawTestOutcome } from './runner.js'
import type { Diagnostic, TestOutcome, TestVerdict } from './verdict.js'
import { rollup } from './verdict.js'

export interface Classification {
  verdict: TestVerdict
  tests: TestOutcome[]
  diagnostics: Diagnostic[]
  durationMs: number
}

export function classifyTest(raw: RawTestOutcome): {
  verdict: TestVerdict
  diagnostics: Diagnostic[]
} {
  const message = raw.message ?? ''

  switch (raw.status) {
    case 'passed':
      return { verdict: 'passed', diagnostics: [] }

    case 'errored':
      return {
        verdict: 'failed_environment',
        diagnostics: [{ kind: classifyError(message), message, ref: raw.target.ref }],
      }

    case 'skipped':
    case 'not_run':
      return { verdict: 'not_collected', diagnostics: [] }

    case 'failed': {
      if (raw.failureKind === 'assertion') {
        return { verdict: 'failed_assertion', diagnostics: [] }
      }
      if (raw.failureKind === 'environment') {
        return {
          verdict: 'failed_environment',
          diagnostics: [{ kind: 'syntax_error', message, ref: raw.target.ref }],
        }
      }
      return {
        verdict: 'failed_environment',
        diagnostics: [
          {
            kind: 'ambiguous',
            message: `runner reported a failure without a failure kind: ${message}`,
            ref: raw.target.ref,
          },
        ],
      }
    }
  }
}

function classifyError(message: string): Diagnostic['kind'] {
  if (/cannot find module|failed to resolve|unable to resolve/i.test(message)) {
    return 'unresolved_import'
  }
  if (/does not provide an export|has no exported member|not exported from/i.test(message)) {
    return 'missing_export'
  }
  return 'syntax_error'
}

export interface ClassifyOptions {
  /**
   * Test files the task expected to run. Any that produced no outcome at all
   * is reported as not_collected, so a runner that silently drops a file
   * cannot look like a clean run.
   */
  expectedRefs?: readonly string[]
}

export function classifyRun(
  result: RawRunResult,
  options: ClassifyOptions = {},
): Classification {
  const tests: TestOutcome[] = []
  const diagnostics: Diagnostic[] = []

  for (const raw of result.tests) {
    const { verdict, diagnostics: found } = classifyTest(raw)
    tests.push({
      id: raw.id,
      ref: raw.ref,
      target: raw.target,
      verdict,
      message: raw.message ?? '',
      ...(raw.location ? { location: raw.location } : {}),
    })
    diagnostics.push(...found)
  }

  const seen = new Set(tests.map((t) => t.ref))
  for (const ref of options.expectedRefs ?? []) {
    if (!seen.has(ref)) {
      tests.push({
        id: `not-collected:${ref}`,
        ref,
        target: { kind: 'file', ref },
        verdict: 'not_collected',
        message: 'expected test produced no result',
      })
    }
  }

  if (result.timedOut) {
    diagnostics.push({ kind: 'timeout', message: 'run exceeded its time budget' })
  }

  const verdict = result.timedOut ? 'timeout' : rollup(tests)
  return { verdict, tests, diagnostics, durationMs: result.durationMs }
}
