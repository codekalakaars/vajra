
/**
 * Harness-collected evidence for plan validation, carried across the turns of
 * one planning conversation.
 *
 * `filesRead` maps a path to the content the model actually read, which is what
 * lets the validator reject a plan that cites a file nobody opened and check an
 * edit's anchor against real text. `baselinesByCommand` is keyed the way
 * `baselineKey` spells a command, holding the exit code observed before any
 * change.
 *
 * The caller owns the lifetime and must call `resetEvidenceLedger` before any
 * phase that writes to the project: once Workers have edited files, the
 * recorded content is stale and an anchor would be validated against text that
 * no longer exists.
 */
export interface PlanEvidenceLedger {
  filesRead: Map<string, string>
  baselinesByCommand: Map<string, number>
}

export function createEvidenceLedger(): PlanEvidenceLedger {
  return { filesRead: new Map(), baselinesByCommand: new Map() }
}

/**
 * Drop everything. Called at the execution boundary, not between turns: within
 * planning nothing writes, so observations stay true, but the moment a plan is
 * confirmed the Workers start changing the files the evidence describes.
 */
export function resetEvidenceLedger(evidence: PlanEvidenceLedger): void {
  evidence.filesRead.clear()
  evidence.baselinesByCommand.clear()
}
