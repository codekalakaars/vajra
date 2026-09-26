// Flake detection and history.
//
// At micro-task volume with several Workers running concurrently, a flaky test
// is a serious failure mode rather than a nuisance: it produces false
// rejections, which produce escalation round trips, which cost far more than
// the flakeness saved. Detection is therefore rerun-based, and a test that
// proves unreliable is reported upward instead of being retried indefinitely —
// a flaky test is a task-definition problem, so it belongs in the escalation
// path.

import { classifyRun, type Classification } from './classify.js'
import type { RunRequest, RunnerAdapter } from './runner.js'
import type { TestVerdict } from './verdict.js'

export const DEFAULT_RERUNS = 3

const RERUN_TRIGGERS: ReadonlySet<TestVerdict> = new Set<TestVerdict>([
  'failed_assertion',
  'timeout',
])

export interface FlakeDetection {
  verdict: TestVerdict
  /** The verdict of every attempt, in order. */
  attempts: TestVerdict[]
  runs: number
  /**
   * The classification of the final attempt. Carried rather than re-derived so
   * the caller never has to run the suite a second time to get its outcomes —
   * a verification that ran the tests twice would halve throughput and could
   * observe two different results.
   */
  final: Classification
}

/**
 * Run until the verdict stops changing, or the rerun budget is spent. A
 * verdict that differs between attempts is `flaky`, which never satisfies a
 * task in any phase — an absence of signal is not evidence.
 */
export async function detectFlake(
  request: RunRequest,
  adapter: RunnerAdapter,
  reruns: number = DEFAULT_RERUNS,
  options: { expectedRefs?: readonly string[] } = {},
): Promise<FlakeDetection> {
  const classify = (result: Awaited<ReturnType<RunnerAdapter['run']>>) =>
    classifyRun(result, { expectedRefs: options.expectedRefs })

  const first = await adapter.run(request)
  const firstClassified = classify(first)

  if (!RERUN_TRIGGERS.has(firstClassified.verdict) || reruns <= 0) {
    return {
      verdict: firstClassified.verdict,
      attempts: [firstClassified.verdict],
      runs: 1,
      final: firstClassified,
    }
  }

  const attempts = [firstClassified.verdict]
  let classified = firstClassified
  let previous = firstClassified.verdict

  for (let i = 0; i < reruns; i += 1) {
    classified = classify(await adapter.run(request))
    attempts.push(classified.verdict)
    if (classified.verdict !== previous) {
      return { verdict: 'flaky', attempts, runs: attempts.length, final: classified }
    }
    previous = classified.verdict
  }

  return { verdict: previous, attempts, runs: attempts.length, final: classified }
}

export interface FlakeHistoryOptions {
  /** How many recent observations to consider per test. */
  window?: number
  /** Flake rate above which a test is considered noisy. */
  threshold?: number
}

interface Observation {
  flaky: number
  total: number
}

/**
 * Rolling flake rate per test. A test that crosses the threshold is reported to
 * the Developer, because at that point reruns are no longer producing a
 * trustworthy verdict and the test itself needs attention.
 */
export class FlakeHistory {
  private readonly records = new Map<string, Observation>()
  private readonly window: number
  private readonly threshold: number

  constructor(options: FlakeHistoryOptions = {}) {
    this.window = options.window ?? 20
    this.threshold = options.threshold ?? 0.2
  }

  record(testId: string, wasFlaky: boolean): void {
    let entry = this.records.get(testId)
    if (!entry) this.records.set(testId, (entry = { flaky: 0, total: 0 }))
    entry.total += 1
    if (wasFlaky) entry.flaky += 1
  }

  rate(testId: string): number {
    const entry = this.records.get(testId)
    if (!entry || entry.total === 0) return 0
    return Math.min(entry.flaky / entry.total, 1)
  }

  isNoisy(testId: string): boolean {
    const entry = this.records.get(testId)
    if (!entry || entry.total < this.window) return false
    return this.rate(testId) >= this.threshold
  }

  noisyTests(): string[] {
    return [...this.records.keys()].filter((id) => this.isNoisy(id)).sort()
  }
}
