import type { AttemptRecord, Handoff } from '../worker/context-types.js'
import { renderCheckpoint } from '../worker/checkpoint.js'

/**
 * What one attempt left for the next one, and what a finished task leaves for the
 * tasks that depend on it.
 *
 * Both are records the runtime writes and the model fills in, and both are
 * joined: a handoff whose file list came from the model would be a summary, and
 * a summary of which files were written is wrong the moment the model is
 * wrong. So the paths and the interfaces are computed from the files themselves,
 * before and after, and the model's part is the sentence that says what a
 * dependent task could not work out from the diff.
 *
 * A dependent task gets a direct dependency's handoff in full and a transitive
 * one's interfaces only. The full record of a task two steps away is mostly
 * noise — it was written against different code — while the declarations it
 * established are exactly what a caller needs.
 */

export interface HandoffInput {
  taskId: string
  title: string
  /** Every file the attempt changed, project-relative. */
  filesWritten: string[]
  /** The file's content before the attempt; `null` when it did not exist. */
  before: Map<string, string | null>
  /** Its content after; `null` when the attempt deleted it. */
  after: Map<string, string | null>
  /** The Worker's closing message. */
  summary: string
  /** The most of the summary passed on. */
  maxSummaryChars: number
}

/**
 * A line that declares something a caller could depend on.
 *
 * Column 0 only, for the same reason `agent/pack.ts` uses the same rule: a
 * declaration inside a body is not the file's interface.
 */
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|class|function|func|fn|pub(?:\s*\([^)]*\))?\s+fn|struct|interface|type|enum)\b/

/** Declaration lines of some content, deduped, in file order. */
export function declarationsOf(content: string | null): string[] {
  if (content === null) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of content.split('\n')) {
    const text = line.trim()
    if (text === '' || !DECLARATION.test(line)) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * The declarations a change added or altered.
 *
 * Compared as lines, not as sets: a declaration whose body changed is the same
 * line and is correctly left out, while a renamed one appears as both the old
 * and the new line, which is what a caller needs to see.
 */
export function changedDeclarations(before: string | null, after: string | null): string[] {
  const was = new Set(declarationsOf(before))
  const now = new Set(declarationsOf(after))
  const out: string[] = []
  for (const line of now) {
    if (was.has(line)) continue
    out.push(line)
  }
  // A declaration that is gone is a change too: a caller reading only interfaces
  // has to know the thing it was told about no longer exists.
  for (const line of was) {
    if (now.has(line)) continue
    out.push(`(removed) ${line}`)
  }
  return out
}

/** The handoff a completed task publishes. */
export function buildHandoff(input: HandoffInput): Handoff {
  const interfaces: string[] = []
  const seen = new Set<string>()
  for (const path of input.filesWritten) {
    // No baseline means no comparison. Treating a missing one as "the file did not
    // exist" would report every declaration in a file the task merely edited as
    // new, which is worse than saying nothing about it.
    if (!input.before.has(path)) continue
    for (const line of changedDeclarations(input.before.get(path) ?? null, input.after.get(path) ?? null)) {
      const entry = `${path}: ${line}`
      if (seen.has(entry)) continue
      seen.add(entry)
      interfaces.push(entry)
    }
  }
  const summary =
    input.summary.length > input.maxSummaryChars
      ? `${input.summary.slice(0, input.maxSummaryChars)}…`
      : input.summary
  return {
    taskId: input.taskId,
    title: input.title,
    filesWritten: [...input.filesWritten],
    interfaces,
    summary: summary.trim(),
  }
}

/** The failure of an attempt, in the two lines that matter. */
function describeFailure(record: AttemptRecord): string[] {
  if (record.failure) {
    return [
      `It failed ${record.failure.command} with exit ${record.failure.exitCode}.`,
      ...(record.failure.outputTail.trim() === ''
        ? []
        : ['The end of what that printed:', record.failure.outputTail.trim()]),
    ]
  }
  if (record.error) return [record.error]
  if (record.outcome === 'stuck') return ['It ran out of room to keep its own state and stopped as stuck.']
  return []
}

/**
 * The block a retry is given about what it is replacing.
 *
 * Every earlier attempt gets one line, because "this has been tried three times"
 * is itself information a Worker should not have to infer from a single story.
 * The most recent attempt gets its failure, its checkpoint and its diff in full,
 * because that is the one the next attempt is most likely to build on or
 * contradict.
 */
export function renderPreviousAttempts(records: readonly AttemptRecord[], diffChars: number): string {
  if (records.length === 0) return ''
  const last = records[records.length - 1]
  const lines: string[] = [
    `This task has been attempted ${records.length} time(s) before. Earlier attempts:`,
    ...records.map(record => {
      const failure = record.failure ? ` (${record.failure.command} exited ${record.failure.exitCode})` : ''
      const files = record.filesWritten.length > 0 ? `, wrote ${record.filesWritten.join(', ')}` : ''
      return `  - attempt ${record.attempt}: ${record.outcome}${failure}${files}`
    }),
    '',
    `The last attempt ended: ${last.outcome}`,
    ...describeFailure(last),
  ]
  if (last.checkpoint) {
    // The checkpoint in full, because it is the one part of the failed attempt
    // that was written to be read by exactly this: the reasoning survives, the
    // conversation does not.
    lines.push('', renderCheckpoint(last.checkpoint))
  }
  if (last.diff !== undefined && last.diff.trim() !== '') {
    lines.push('', 'What it had changed when it stopped:', last.diff.slice(0, diffChars))
  }
  lines.push(
    '',
    'Those changes were rolled back, so the files are as they were before that attempt. Use what is',
    'above as evidence about the approach, not as code you can rely on being on disk.',
  )
  return lines.join('\n')
}