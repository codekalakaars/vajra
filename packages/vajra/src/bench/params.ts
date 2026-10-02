import type { ReasoningEffort } from '../model/chat.js'

/**
 * Every parameter that arranges a run, as `bench/config.json` holds it.
 *
 * That file is the only source of these values: no environment variable, flag
 * or built-in default stands in for a missing key. The shape here and the file
 * must change together.
 *
 * The bench command that reads it:
 *
 *   vajra bench <suite-dir> [--config <file>] [--out <result.json>]
 *
 *   --config  defaults to bench/config.json; exists for the sweep, which
 *             writes a whole candidate file rather than setting one value
 *   --out     where the BenchResult is written
 *
 *   exit 0  every task completed and the acceptance command passed
 *   exit 1  the run failed
 *   exit 2  setup error: bad config, invalid plan, missing suite files
 */
export interface WorkerParams {
  /**
   * There is no Worker count. A task starts while the CPU is below
   * `cpuResumeAt` and RAM would stay above `minFreeMemMb` with one more Worker;
   * at `cpuPauseAt` the lowest-priority Worker is paused until the CPU recovers.
   * See `agent/governor.ts`.
   */
  /** CPU share (0..1) at or above which the lowest-priority Worker is paused. */
  cpuPauseAt: number
  /** CPU share (0..1) below which a paused Worker resumes or a new one starts. Below `cpuPauseAt`. */
  cpuResumeAt: number
  /**
   * The share of the machine (0..1) this run must itself be using for a busy CPU to count.
   * Below it, the load is someone else's: nothing is paused and Workers keep starting.
   */
  cpuOwnMin: number
  /** RAM, in MB, that must stay available after starting a Worker. */
  minFreeMemMb: number
  /** RAM, in MB, one Worker is assumed to need until a reading shows otherwise. */
  workerMemMb: number
  /** How often CPU and RAM are read, in ms. */
  resourceSampleMs: number
  /** Which ready task gets the next free slot. */
  scheduleOrder: ScheduleOrder
  /** Whether tasks that only read the same file can run together. */
  readLocks: ReadLockMode
  workerModel: string
  workerReasoning: ReasoningEffort
  /** Tool calls one attempt may make before it is cut off. */
  workerMaxToolCalls: number
  /** Limit on one whole attempt, not only its validation commands. */
  taskTimeoutSec: number
  /** Attempts after the first, for every task; a plan's own `retries` is ignored. */
  retries: number
  /** Put each read file's content in the Worker's first message. */
  preloadReads: boolean
  /**
   * The most characters of one tool result a Worker keeps. Command output keeps
   * its end, anything else its beginning; a cut result says how to get the rest.
   */
  toolOutputMaxChars: number
  /**
   * Seconds a model request may go without hearing from the gateway (no headers, or no
   * chunk once streaming) before it is abandoned and the round is sent again.
   */
  modelStallSec: number
  /** Sandboxes kept warm between tasks. */
  warmSandboxes: number

  // --- context management (see VAJRA_TUNING_PLAN.md, K2–K4) ---------------
  /** Start each Worker from a compiled context pack in its system prompt. */
  contextPack: boolean
  /** The most of the Worker's window the pack may take, 0..1. */
  packWindowShare: number
  /** Lines shown on each side of an edit's anchor. */
  anchorContextLines: number
  /** Rung 1: rewrite stale tool results in place once the window passes `elideAt`. */
  elision: boolean
  elideAt: number
  /** Rounds elision never touches. */
  keepRecentRounds: number
  /** Lines kept of a spent command's output. */
  elidedTailLines: number
  /** Rung 2: compact into a checkpoint once the window passes `compactAt`. */
  checkpoints: boolean
  compactAt: number
  /** A checkpoint bigger than this share of the window ends the attempt `stuck`. */
  stuckCheckpointShare: number
  /** Compactions with no progress before the attempt ends `stuck`. */
  maxCompactionsWithoutProgress: number
  /** Diff of in-progress files carried into a checkpoint, in characters. */
  checkpointDiffChars: number
  /** Tell a retry what the last attempt did and why it failed. */
  respawnContext: boolean
  /** Diff of the failed attempt shown to the retry, in characters. */
  respawnDiffChars: number
  /** The most of a finished task's summary passed to its dependents. */
  handoffSummaryChars: number
}

export type ScheduleOrder = 'plan' | 'critical-path' | 'most-dependents'

export type ReadLockMode = 'exclusive' | 'shared'

/**
 * The values `bench/config.json` starts with. Passed where the code has no
 * loaded config: an interactive session, and tests.
 */
export const TODAYS_PARAMS: Readonly<WorkerParams> = Object.freeze({
  cpuPauseAt: 0.9,
  cpuResumeAt: 0.75,
  cpuOwnMin: 0.1,
  minFreeMemMb: 1024,
  workerMemMb: 256,
  resourceSampleMs: 1000,
  scheduleOrder: 'plan',
  readLocks: 'exclusive',
  workerModel: 'zen/space-bunny-free',
  workerReasoning: 'off',
  workerMaxToolCalls: 100,
  taskTimeoutSec: 300,
  retries: 2,
  preloadReads: false,
  toolOutputMaxChars: 20000,
  modelStallSec: 45,
  warmSandboxes: 1,
  contextPack: false,
  packWindowShare: 0.35,
  anchorContextLines: 12,
  elision: false,
  elideAt: 0.5,
  keepRecentRounds: 3,
  elidedTailLines: 20,
  checkpoints: false,
  compactAt: 0.7,
  stuckCheckpointShare: 0.4,
  maxCompactionsWithoutProgress: 3,
  checkpointDiffChars: 6000,
  respawnContext: false,
  respawnDiffChars: 8000,
  handoffSummaryChars: 800,
})
