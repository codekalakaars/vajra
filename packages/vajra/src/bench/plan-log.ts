import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEvent } from '../manager/ui.js'

/**
 * One line a person can read about something the Developer did, or `null` for an
 * event that is only noise (a round starting says nothing its end does not).
 */
export function describeAgentEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case 'phase':
      return `phase: ${event.phase}`
    case 'llm-end': {
      const tokens = event.usage ? `, ${event.usage.promptTokens} in / ${event.usage.completionTokens} out` : ''
      const round = event.budget ? `${event.round}/${event.budget}` : `${event.round}`
      return `model round ${round}: ${(event.ms / 1000).toFixed(1)}s${tokens}`
    }
    case 'llm-stall':
      return `model went quiet for ${Math.round(event.afterMs / 1000)}s in round ${event.round}; sent again`
    case 'tool-start':
      return `-> ${event.tool} ${event.summary}`
    case 'tool-end': {
      // A baseline that exits non-zero is an observation, often the one wanted:
      // a command that must fail before the change is "FAILED" only to the tool.
      const observed = event.tool === 'run_baseline' && /^exit \d+/.test(event.detail ?? '')
      return `   ${event.ok || observed ? 'ok' : 'FAILED'} ${event.tool} ${(event.ms / 1000).toFixed(1)}s${event.detail ? `  ${event.detail}` : ''}`
    }
    case 'warning':
      return `note: ${event.text}`
    default:
      return null
  }
}

/** Silence shorter than this is a model thinking, not worth a line. */
const QUIET_AFTER_SECONDS = 15

export interface PlanLog {
  /** Where the checkpoints are being written. */
  readonly path: string
  /** A checkpoint of the run itself (a case started, a question asked, a verdict). */
  note(text: string): void
  /** A checkpoint from the Developer. Events with nothing to say are dropped. */
  event(event: AgentEvent): void
  /** Called every so often with nothing new to say: names how long it has been quiet. */
  quiet(): void
}

/**
 * The checkpoints of one planning run, in two places at once: printed as they
 * happen, so a person watching knows the run is alive, and appended to a file
 * under the case so there is a record after the terminal is gone. The file is
 * written a line at a time, so a run that is killed still leaves everything up to
 * the moment it died.
 *
 * Each line carries the seconds since the run began, because the question a log is
 * usually read for is where the time went.
 */
export function createPlanLog(options: {
  /** The case's own directory: the log goes in its `runs/`, not in the temporary project. */
  caseDir: string
  /** A name that sorts by time and is safe in a file name. */
  stamp: string
  write: (line: string) => void
  now?: () => number
}): PlanLog {
  const now = options.now ?? Date.now
  const startedAt = now()
  const path = join(options.caseDir, 'runs', `${options.stamp}.log`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '', 'utf-8')
  let lastAt = startedAt

  const line = (text: string): void => {
    const at = now()
    lastAt = at
    const stamped = `+${((at - startedAt) / 1000).toFixed(1).padStart(6)}s  ${text}`
    appendFileSync(path, `${stamped}\n`, 'utf-8')
    options.write(stamped)
  }

  return {
    path,
    note: line,
    event: event => {
      const text = describeAgentEvent(event)
      if (text !== null) line(text)
    },
    quiet: () => {
      const seconds = Math.round((now() - lastAt) / 1000)
      if (seconds >= QUIET_AFTER_SECONDS) line(`... waiting, ${seconds}s since the last checkpoint`)
    },
  }
}
