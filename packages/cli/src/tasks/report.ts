import type { QueueStatus } from '../agent/taskqueue.js'

export interface FinalReport {
  lines: string[]
  exitCode: number
}

/**
 * Build the end-of-run report and exit code from the final queue status.
 * D5: pending tasks are surfaced and force a non-zero exit.
 */
export function finalReport(status: QueueStatus): FinalReport {
  const lines: string[] = []
  const pending = status.pending + status.assigned + status.running
  const failed = status.failed

  const parts = [
    `Completed: ${status.done}`,
    `Failed: ${failed}`,
    `Skipped: ${status.skipped}`,
    `Pending: ${pending}`,
  ]
  lines.push(parts.join('  '))

  const exitCode = failed > 0 || pending > 0 ? 1 : 0
  return { lines, exitCode }
}
