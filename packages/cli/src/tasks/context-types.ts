import type { PlanContract } from '@codekalakaars/vajra-protocol'

/**
 * The shapes the context batches share: what a Worker starts from (the pack),
 * what it records as it works (the ledger), what it keeps when it compacts (the
 * checkpoint), and what it leaves for the next attempt and the next task (the
 * attempt record and the handoff).
 *
 * The runtime owns every field it can observe — files written, commands run,
 * exit codes. The model is only asked for what the runtime cannot know: why,
 * and what is left.
 */

/** One section of a context pack, as built and as measured. */
export interface PackSection {
  name: string
  text: string
  /** Estimated tokens, by the model's calibrated ratio. */
  tokens: number
  /** True for sections the budget may never cut. */
  fixed: boolean
}

/** The Worker's L0: compiled at dispatch, deterministic, budgeted. */
export interface ContextPack {
  text: string
  /** sha256 of `text`: same plan, same disk, same handoffs, same hash. */
  hash: string
  sections: PackSection[]
  tokens: number
  /** What the budget cut, each with the call that fetches it back. */
  omitted: string[]
  /** Anchors no longer found where the plan put them. */
  staleAnchors: string[]
  /** Anchors found again by their most distinctive line. */
  relocatedAnchors: string[]
  /** Every path whose content the pack shows, normalized. Seek ratio is measured against it. */
  paths: string[]
}

/** One thing a Worker did, recorded by the runtime as it happened. */
export interface WorkLedgerEntry {
  round: number
  tool: string
  /** The file a file tool touched, project-relative as the Worker named it. */
  path?: string
  /** A command as run, argv joined. */
  command?: string
  exitCode?: number
  /** Whether the call changed a file. */
  mutated: boolean
  ok: boolean
}

/** ADR-0015's checkpoint, with the fields the runtime owns filled by the runtime. */
export interface Checkpoint {
  sequence: number
  /** Runtime-owned: every file the ledger saw this attempt change. */
  filesChanged: string[]
  decisions: { decision: string; reason: string }[]
  done: string[]
  remaining: string[]
  /** Runtime-owned: the last validation-style command and how it ended. */
  lastVerification?: { command: string; exitCode: number }
  /** The model's own note, when it left one. */
  notes?: string
}

export type AttemptOutcome = 'done' | 'failed_verification' | 'stuck' | 'error' | 'timeout' | 'budget' | 'interrupted'

/** What one attempt left behind, for the next attempt at the same task. */
export interface AttemptRecord {
  attempt: number
  outcome: AttemptOutcome
  /** The command that decided a `failed_verification`, and the tail of what it printed. */
  failure?: { command: string; exitCode: number; outputTail: string }
  /** For outcomes other than a failed check: what went wrong, in a line. */
  error?: string
  checkpoint?: Checkpoint
  filesWritten: string[]
  /** The attempt's changes as a diff, captured before the rollback. */
  diff?: string
  /** The Worker's closing message, when it ended by saying it was done. */
  summary?: string
}

/** What a completed task tells the tasks that depend on it. */
export interface Handoff {
  taskId: string
  title: string
  /** Runtime: from the ledger. */
  filesWritten: string[]
  /** Runtime: exported declarations added or changed, from the files' before and after. */
  interfaces: string[]
  /** Worker: its closing message, capped. */
  summary: string
}

/**
 * Everything around a task that the Worker's context is built from. Supplied
 * by the host per attempt; every field is optional so a caller with none of it
 * (a test, an interactive session with the features off) passes nothing.
 */
export interface WorkerContext {
  /** The plan's contracts; the pack shows those naming this task. */
  contracts?: PlanContract[]
  /** Built once per run from the project's manifests. */
  projectCard?: string
  /** Handoffs of the task's direct dependencies, then of transitive ones. */
  upstream?: { direct: Handoff[]; transitive: Handoff[] }
  /** Earlier attempts at this task, oldest first. */
  previousAttempts?: AttemptRecord[]
  /** Called once when the attempt ends, with what it left behind. */
  onAttemptEnd?: (record: Omit<AttemptRecord, 'attempt' | 'diff'>) => void
}
