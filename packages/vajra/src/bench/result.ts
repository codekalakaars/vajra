import type { WorkerParams } from './params.js'

/** What one `vajra bench` run writes to `--out`. */
export interface BenchResult {
  suite: string
  /** The full config the run used. */
  config: WorkerParams
  /** Every task completed and the acceptance command passed. */
  success: boolean
  failureReason?: string
  /** First Worker spawned to last task completed. */
  wallMs: number
  /**
   * The longest chain of dependent or same-file tasks, by measured duration:
   * the floor no arrangement of Workers can beat.
   */
  criticalPathMs: number
  /**
   * Summed time tasks were ready but not running. Ready means dependencies
   * settled and no file the task needs held by another task, so this is only
   * time a free slot would have recovered.
   */
  idleMs: number
  /**
   * Summed time Workers spent paused because the CPU was saturated. Paused time
   * is inside each task's duration, so it raises `criticalPathMs`: a run that
   * pauses a lot is one the machine, not the arrangement, is slowing down.
   */
  pausedMs: number
/**
 * The fullest any Worker's context got, as a share of the model's window
 * (0..1), from the prompt tokens the provider reported. Near 1 means suite
 * tasks are big enough that compaction (ADR-0015) is worth building.
   */
  peakContextShare: number
  /** Times any Worker's history was trimmed to fit its window. */
  contextTrims: number
  /**
   * How much of what Workers looked for, the pack did not already hold, over
   * every task and every tool call. High means the pack is missing what Workers
   * look for; `mostMissedPaths` says what.
   */
  seekRatio: number
  /** Total pack tokens across the run's tasks. */
  packTokens: number
  /** Parts of a pack the budget cut, across the run. */
  packSectionsCut: number
  /** Tool results rewritten by elision, across the run. */
  elisions: number
  /** Checkpoints written, across the run. */
  compactions: number
  /** Attempts that ended stuck, across the run. */
  stuck: number
  /**
   * The paths read outside the pack, most-missed first. This is the list that
   * says what a pack should have carried.
   */
  mostMissedPaths: { path: string; count: number }[]
  tasks: BenchTaskResult[]
}

export interface BenchTaskResult {
  id: string
  title: string
  /** Epoch ms. Absent when the task never reached that point. */
  readyAt?: number
  startedAt?: number
  endedAt?: number
  status: 'done' | 'failed' | 'skipped' | 'pending'
  attempts: number
  modelRounds: number
  toolCalls: number
  /** Time this task's Worker was paused. */
  pausedMs: number
  /** The largest prompt one of its model rounds sent, in tokens; 0 when none was reported. */
  peakPromptTokens: number
  /** `peakPromptTokens` as a share of the Worker model's window. */
  peakContextShare: number
  /** Times its history was trimmed to fit the window. */
  contextTrims: number

  // --- context management (VAJRA_TUNING_PLAN.md, K5) -----------------------
  /** Estimated tokens in the pack this task's Worker started from; 0 without one. */
  packTokens: number
  /** sha256 of the pack, so two runs can be compared on the same brief. */
  packHash?: string
  /** Parts of the pack the budget cut. */
  packSectionsCut: number
  /** Paths the pack showed, normalised. Seek ratio is measured against it. */
  packPaths: string[]
  /** Anchors the plan could no longer find. */
  staleAnchors: number
  /** Anchors found again by their most distinctive line. */
  relocatedAnchors: number
  /** Reads, searches and listings of a path the pack did not carry. */
  seeks: number
  /** `seeks` over `toolCalls`: the share of its looking-for that the pack covered. */
  seekRatio: number
  /**
   * Reads of a path the pack already showed, made before the Worker changed it —
   * the pack was not read.
   */
  redundantReads: number
  /**
   * Model rounds before the first write, or `null` when the Worker never wrote.
   * The clearest single number for "did the brief get it started".
   */
  roundsToFirstEdit: number | null
  /** Tool results this task's elision rewrote. */
  elisions: number
  /** Checkpoints this task's Worker wrote. */
  compactions: number
  /** Times this task's Worker ended stuck. */
  stuck: number
}
