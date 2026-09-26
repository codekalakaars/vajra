// Mutation as a verification criterion.
//
// The question this answers is not "did the tests pass" — the other criteria
// already do that. It is "would these tests have caught a defect". A suite can
// be green and worthless, and nothing else in this system can tell the
// difference; a seeded defect can.
//
// Three rules make the resulting number mean something:
//
//   1. A green baseline is required. If the tests already fail, "a test failed
//      on the mutant" is indistinguishable from "the test was already failing",
//      and the score would be noise. Phase One is therefore explicitly not
//      applicable rather than guessed at.
//
//   2. Compile errors and timeouts are excluded from scoring, not counted as
//      failures. A mutant that does not compile is not a defect a test could
//      have caught, and charging it against the score punishes the toolchain.
//
//   3. No coverage is reported separately from survived, and both count as
//      undetected. They need different fixes — an untested line versus a wrong
//      assertion — and a single blended number would hide the distinction that
//      tells the Developer what to do next.

import type { RawRunResult, RawTestOutcome, RunRequest, RunnerAdapter } from '../runner.js'
import { parseMutationReport, type MutationReport } from './report.js'
import { cliTarget, type TestTarget } from '../target.js'
import { isSatisfied } from '../verdict.js'

export interface MutationCriterion {
  id: string
  type: 'mutation'
  description?: string
  /**
   * The mutation tool, already scoped by the Developer to the task's files. A
   * mutation run is expensive, so the scope belongs in the plan, not in a
   * default that guesses.
   */
  command: readonly string[]
  /** Where the tool writes its report. */
  reportPath: string
  reportFormat?: 'stryker' | 'mutmut' | 'simple' | 'auto'
  /**
   * Fraction of scorable mutants that must be killed. Defaults to 1.0 because
   * the scope is the task's own code, where an undetected mutant is a real
   * gap rather than background noise.
   */
  minKillRate?: number
  /** Inject these files, or leave the tool's own scope. */
  cwd?: string
  timeoutMs?: number
}

export interface MutationCriterionConfig {
  criteria: readonly MutationCriterion[]
  /** The runner that establishes the baseline, i.e. the task's other tests. */
  baseline: RunnerAdapter
}

export interface MutationScore {
  criterionId: string
  /** False when a green baseline is required and absent. */
  applicable: boolean
  reason?: string
  total: number
  scorable: number
  killed: number
  survived: number
  noCoverage: number
  /** Not scored: a mutant that does not compile is not a catchable defect. */
  excluded: number
  killRate: number
  minKillRate: number
  /** Mutants nothing detected, in the order reported. */
  undetected: Array<{ id: string; file: string; line?: number; status: string }>
  durationMs: number
}

export interface MutationRunResult {
  outcomes: RawTestOutcome[]
  scores: MutationScore[]
  durationMs: number
}

const SCORABLE: ReadonlySet<string> = new Set(['killed', 'survived', 'no_coverage'])

export function createMutationRunner(
  config: MutationCriterionConfig,
  deps: {
    exec?: (argv: readonly string[], options: { cwd?: string; timeoutMs: number }) => Promise<{ stdout: string; code: number | null }>
    readFile?: (path: string) => Promise<string>
  } = {},
): RunnerAdapter & { runMutation(criteria: readonly MutationCriterion[]): Promise<MutationRunResult> } {
  const exec = deps.exec ?? defaultExec
  const read = deps.readFile ?? ((p: string) => import('node:fs/promises').then((m) => m.readFile(p, 'utf8')))

  const runMutation = async (criteria: readonly MutationCriterion[]): Promise<MutationRunResult> => {
    const started = Date.now()
    const outcomes: RawTestOutcome[] = []
    const scores: MutationScore[] = []

    // The baseline is run once, not per criterion: every mutation criterion on
    // a task shares the same starting state, and re-running it would multiply
    // the cost for no new information.
    const baselineRun = await config.baseline.run({
      taskId: 'mutation-baseline',
      testRefs: [],
      cwd: criteria[0]?.cwd ?? process.cwd(),
      timeoutMs: 120_000,
    })
    const baselineGreen = baselineRun.tests.every((t) => t.status === 'passed')

    for (const criterion of criteria) {
      const target: TestTarget = cliTarget(`mutation:${criterion.command.join(' ')}`)
      const minKillRate = criterion.minKillRate ?? 1

      if (!baselineGreen) {
        // Rule 1. A red baseline makes every kill indistinguishable from noise.
        const score: MutationScore = {
          criterionId: criterion.id,
          applicable: false,
          reason:
            'the suite is not green on the unmodified code, so no mutant can be ' +
            'attributed to a test; resolve the baseline first',
          total: 0,
          scorable: 0,
          killed: 0,
          survived: 0,
          noCoverage: 0,
          excluded: 0,
          killRate: 0,
          minKillRate,
          undetected: [],
          durationMs: 0,
        }
        scores.push(score)
        outcomes.push({
          id: `mutation:${criterion.id}`,
          ref: criterion.id,
          target,
          status: 'errored',
          message: `mutation scoring not applicable: ${score.reason}`,
        })
        continue
      }

      let report: MutationReport | null = null
      let failure: string | undefined
      try {
        const run = await exec([...criterion.command], {
          cwd: criterion.cwd,
          timeoutMs: criterion.timeoutMs ?? 300_000,
        })
        if (run.code !== 0) {
          failure = `mutation tool exited ${run.code}: ${run.stdout.trim().slice(0, 300)}`
        }
      } catch (error) {
        failure = `could not run the mutation tool: ${error instanceof Error ? error.message : String(error)}`
      }

      if (!failure) {
        try {
          report = parseMutationReport(
            await read(criterion.reportPath),
            criterion.reportFormat ?? 'auto',
          )
          if (!report) failure = `could not parse a mutation report at ${criterion.reportPath}`
        } catch (error) {
          failure = `could not read ${criterion.reportPath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        }
      }

      if (failure || !report) {
        const score: MutationScore = {
          criterionId: criterion.id,
          applicable: false,
          reason: failure,
          total: 0,
          scorable: 0,
          killed: 0,
          survived: 0,
          noCoverage: 0,
          excluded: 0,
          killRate: 0,
          minKillRate,
          undetected: [],
          durationMs: 0,
        }
        scores.push(score)
        outcomes.push({
          id: `mutation:${criterion.id}`,
          ref: criterion.id,
          target,
          status: 'errored',
          message: failure,
        })
        continue
      }

      const score = scoreReport(criterion, report)
      scores.push(score)

      if (score.total === 0) {
        outcomes.push({
          id: `mutation:${criterion.id}`,
          ref: criterion.id,
          target,
          status: 'errored',
          message: 'the mutation tool reported no mutants, so nothing was verified',
        })
        continue
      }

      // Each mutant becomes an outcome, so a surviving one is visible in the
      // per-test list rather than hidden inside a single score line. Both
      // messages name the mutant and its location: "killed by t1" alone does
      // not tell a reader which of forty mutants was involved, and the killed
      // ones are what you compare the survivors against.
      for (const mutant of report.mutants) {
        const detected = mutant.status === 'killed'
        const where = `${mutant.file}${mutant.line ? `:${mutant.line}` : ''}`
        outcomes.push({
          id: `mutation:${criterion.id}:${mutant.id}`,
          ref: criterion.id,
          target: cliTarget(`${criterion.command.join(' ')} ${mutant.file}`),
          status: detected ? 'passed' : 'failed',
          failureKind: detected ? undefined : 'assertion',
          message: detected
            ? `${mutant.mutator} at ${where} killed by ${mutant.killedBy.join(', ') || 'a test'}`
            : `${mutant.mutator} at ${where} ${mutant.status.replace('_', ' ')}`,
        })
      }
    }

    return { outcomes, scores, durationMs: Date.now() - started }
  }

  return {
    name: 'mutation',
    version: '1',
    run: async (request: RunRequest): Promise<RawRunResult> => {
      const result = await runMutation(config.criteria)
      return { tests: result.outcomes, durationMs: result.durationMs }
    },
    runMutation,
  }
}

export function scoreReport(criterion: MutationCriterion, report: MutationReport): MutationScore {
  let killed = 0
  let survived = 0
  let noCoverage = 0
  let excluded = 0
  const undetected: MutationScore['undetected'] = []

  for (const mutant of report.mutants) {
    if (!SCORABLE.has(mutant.status)) {
      // Rule 2. A non-compiling mutant is not a defect a test could catch.
      excluded += 1
      continue
    }
    if (mutant.status === 'killed') killed += 1
    else if (mutant.status === 'survived') {
      survived += 1
      undetected.push({ id: mutant.id, file: mutant.file, line: mutant.line, status: mutant.status })
    } else {
      noCoverage += 1
      // Rule 3. Reported apart from survived: an untested line and a wrong
      // assertion need different fixes.
      undetected.push({ id: mutant.id, file: mutant.file, line: mutant.line, status: mutant.status })
    }
  }

  const scorable = killed + survived + noCoverage
  return {
    criterionId: criterion.id,
    applicable: true,
    total: report.mutants.length,
    scorable,
    killed,
    survived,
    noCoverage,
    excluded,
    killRate: scorable === 0 ? 1 : killed / scorable,
    minKillRate: criterion.minKillRate ?? 1,
    undetected,
    durationMs: report.durationMs,
  }
}

/**
 * A surviving mutant is an oracle failure: the tests did not detect a defect
 * that is demonstrably present. That maps onto `failed_assertion`, so it is
 * subject to the same rules as every other assertion failure — including never
 * satisfying a task in Phase One.
 */
export function verdictForScore(score: MutationScore): {
  expected: 'pass'
  satisfied: boolean
} {
  const expected = 'pass' as const
  return {
    expected,
    satisfied: isSatisfied(expected, score.applicable && score.killRate >= score.minKillRate ? 'passed' : 'failed_assertion'),
  }
}

async function defaultExec(
  argv: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<{ stdout: string; code: number | null }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout?.on('data', (c) => {
      stdout += String(c)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, code })
    })
  })
}
