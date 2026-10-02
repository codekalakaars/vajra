import type { ChatMessage, OpenAiToolSpec } from '../model/chat.js'
import type { Checkpoint } from './context-types.js'
import type { WorkLedger } from './ledger.js'
import { diffsWithin, type DiffFile } from './diff.js'

/**
 * Rung 2 of the compaction ladder: replace the conversation with a checkpoint,
 * the runtime's ledger, and a diff.
 *
 * The runtime asks for the checkpoint, one round, with only this tool on offer —
 * so the Worker is never offered `write_checkpoint` during ordinary work and
 * cannot spend a round on it. That is deliberate: ADR-0015 says the *runtime*
 * decides when to compact, and a tool the Worker may call whenever it likes is a
 * compaction it can skip.
 *
 * The checkpoint's own fields are the model's; two of them are not. `filesChanged`
 * comes from the ledger and `lastVerification` from the command it recorded,
 * because those are facts about the harness's own actions and a model asked to
 * recall them will recall its intentions instead. Everything else — decisions,
 * done, remaining, notes — is exactly the part only the model knows.
 */

/** The name the runtime requires, on the round it requires it. */
export const CHECKPOINT_TOOL = 'write_checkpoint'

export const CHECKPOINT_TOOL_SPEC: OpenAiToolSpec = {
  type: 'function',
  function: {
    name: CHECKPOINT_TOOL,
    description:
      'Record your state so a fresh conversation can continue this task. Your context is about ' +
      'to be replaced by this record plus the runtime ledger. Write what only you know: the ' +
      'decisions you took and why, what is done, what is left in order, and anything a ' +
      'replacement would get wrong. Do not list files you changed — the runtime records those.',
    parameters: {
      type: 'object',
      properties: {
        decisions: {
          type: 'array',
          description: 'Each decision made, with the reason for it.',
          items: {
            type: 'object',
            properties: {
              decision: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['decision', 'reason'],
            additionalProperties: false,
          },
        },
        done: { type: 'array', items: { type: 'string' }, description: 'What is complete.' },
        remaining: { type: 'array', items: { type: 'string' }, description: 'What is left, in order.' },
        notes: { type: 'string', description: 'Anything else the next context needs. Optional.' },
      },
      required: ['decisions', 'done', 'remaining'],
      additionalProperties: false,
    },
  },
}

/** A string list, dropping anything that is not one. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item).trim()).filter(item => item !== '')
}

/**
 * What the model filled in, with nothing invented for it.
 *
 * Hand-validated rather than schema-validated: the CLI validates its own input
 * everywhere, and a checkpoint that arrives malformed must still compact rather
 * than throw — a Worker that cannot say what it is doing still has the ledger.
 */
export function parseCheckpoint(args: unknown): Omit<Checkpoint, 'sequence' | 'filesChanged'> {
  const a = (args ?? {}) as Record<string, unknown>
  const decisions = Array.isArray(a.decisions)
    ? a.decisions
        .map(entry => {
          const d = (entry ?? {}) as Record<string, unknown>
          return {
            decision: typeof d.decision === 'string' ? d.decision.trim() : '',
            reason: typeof d.reason === 'string' ? d.reason.trim() : '',
          }
        })
        .filter(entry => entry.decision !== '')
    : []
  return {
    decisions,
    done: stringList(a.done),
    remaining: stringList(a.remaining),
    ...(typeof a.notes === 'string' && a.notes.trim() !== '' ? { notes: a.notes.trim() } : {}),
  }
}

/**
 * The checkpoint as the runtime stores it: the model's fields, plus the two it
 * owns. `sequence` counts this task's compactions, so two checkpoints are never
 * equal by accident.
 */
export function completeCheckpoint(
  model: Omit<Checkpoint, 'sequence' | 'filesChanged'>,
  sequence: number,
  ledger: WorkLedger,
): Checkpoint {
  const lastVerification = ledger.lastVerification()
  return {
    sequence,
    filesChanged: ledger.filesWritten(),
    decisions: model.decisions,
    done: model.done,
    remaining: model.remaining,
    ...(lastVerification !== undefined ? { lastVerification } : {}),
    ...(model.notes !== undefined ? { notes: model.notes } : {}),
  }
}

function renderList(lines: string[], label: string, items: readonly string[], empty: string): void {
  if (items.length === 0) {
    lines.push(`${label}: ${empty}`)
    return
  }
  lines.push(`${label}:`)
  for (const item of items) lines.push(`  - ${item}`)
}

/** The checkpoint as text. A record of what only the model could say. */
export function renderCheckpoint(checkpoint: Checkpoint): string {
  const lines: string[] = ['# Checkpoint', '']
  lines.push(`(compaction ${checkpoint.sequence})`)
  renderList(lines, 'Files changed (recorded by the runtime)', checkpoint.filesChanged, 'none')
  renderList(
    lines,
    'Last verification (recorded by the runtime)',
    checkpoint.lastVerification
      ? [`${checkpoint.lastVerification.command} → exit ${checkpoint.lastVerification.exitCode}`]
      : [],
    'none — no command has been run yet',
  )
  lines.push('')
  renderList(lines, 'Decisions', checkpoint.decisions.map(d => `${d.decision} — ${d.reason}`), 'none recorded')
  renderList(lines, 'Done', checkpoint.done, 'nothing yet')
  renderList(lines, 'Remaining', checkpoint.remaining, 'nothing')
  if (checkpoint.notes !== undefined && checkpoint.notes !== '') {
    lines.push('')
    lines.push(`Notes: ${checkpoint.notes}`)
  }
  return lines.join('\n')
}

/** What the harness saw this attempt, in the few lines worth carrying. */
export function renderLedger(ledger: WorkLedger): string {
  const commands = ledger.commandSummary()
  const lines = ['# Runtime ledger', '']
  lines.push(`Files this attempt wrote: ${ledger.filesWritten().join(', ') || 'none'}`)
  if (commands.length === 0) {
    lines.push('Commands run: none')
  } else {
    lines.push('Commands run:')
    for (const command of commands) lines.push(`  - ${command}`)
  }
  return lines.join('\n')
}

/**
 * What the compacted conversation becomes: the system prompt, the task message,
 * and then the L1 block — checkpoint, ledger, and the diff of what changed.
 *
 * The task message is kept verbatim because it is the only statement of what was
 * asked that nothing else repeats, and it is short. Everything else the Worker
 * said and read is in L3: on disk, or one `read_file` away.
 */
export function compactedMessages(input: {
  system: string
  taskMessage: string
  checkpoint: Checkpoint
  ledger: WorkLedger
  diffs: readonly DiffFile[]
  diffChars: number
}): ChatMessage[] {
  const diff = diffsWithin(input.diffs, input.diffChars)
  const l1 = [
    renderCheckpoint(input.checkpoint),
    '',
    renderLedger(input.ledger),
    '',
    '# Changes so far',
    '',
    diff === '' ? 'No tracked file has changed yet.' : diff,
    '',
    'Continue the task from this record. Read a file again only if you need a part of it that is not shown here.',
  ].join('\n')
  return [
    { role: 'system', content: input.system },
    { role: 'user', content: input.taskMessage },
    { role: 'user', content: l1 },
  ]
}

/** What was true at the last compaction, so the next one can tell progress from repetition. */
export interface ProgressMark {
  /** Files written by then. */
  files: string[]
  /** Commands that had failed by then. */
  failing: string[]
}

/** The mark a fresh attempt starts from. */
export function markAt(ledger: WorkLedger): ProgressMark {
  return {
    files: ledger.filesWritten(),
    failing: ledger.commands().filter(c => c.exitCode !== 0).map(c => c.command),
  }
}

/**
 * Progress since the last compaction.
 *
 * A file that had not been written before, or a command that now passes where it
 * did not. Three compactions with neither is a Worker going round in circles, and
 * that is what `maxCompactionsWithoutProgress` counts.
 */
export function madeProgress(since: ProgressMark, ledger: WorkLedger): boolean {
  if (ledger.filesWritten().some(path => !since.files.includes(path))) return true
  return ledger.commands().some(({ command, exitCode }) => since.failing.includes(command) && exitCode === 0)
}