import type {
  
  
  PlanEvidence,
  PlannedTask,
  PlannedTaskInput
} from '@codekalakaars/vajra-protocol'
import { resolve } from 'node:path'
import { type ChatMessage, 
} from '../model/chat.js'
import {
  tokenizeCommand
} from '@codekalakaars/vajra-sandbox'

/** Canonical key for a baseline observation: argv (tokenized so a bundled
 *  command string and an argv-form one match) plus the resolved cwd. */
export function baselineKey(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  projectDir: string,
): string {
  const tokenized = tokenizeCommand(command)
  const argv = tokenized.ok ? [...tokenized.argv, ...args] : [command, ...args]
  return JSON.stringify([argv, resolve(projectDir, cwd ?? '.')])
}

/**
 * Which task shape a task is written in.
 *
 * `structured` is the only shape a plan may use: context/edits/verify are the
 * fields the validator can actually check (a file was really read, an anchor
 * really appears, a baseline really failed). `flat` and `empty` declare no
 * target files and no success criteria, so nothing about them can be verified —
 * they are reported here so the dispatcher can reject them with an
 * explanation. A plan that mixes shapes gets half its tasks verified and half
 * skipped, so it is rejected and named rather than silently lowered.
 */
function taskShape(task: PlannedTaskInput): 'structured' | 'flat' | 'empty' {
  if ((task.edits?.length ?? 0) > 0 || (task.context?.length ?? 0) > 0 || (task.verify?.length ?? 0) > 0) {
    return 'structured'
  }
  if (
    (task.instructions?.length ?? 0) > 0 ||
    (task.readFile?.length ?? 0) > 0 ||
    (task.writeFile?.length ?? 0) > 0
  ) {
    return 'flat'
  }
  return 'empty'
}

const q = (s: string): string => `'${s}'`

/** Hard ceiling on one plan, enforced rather than merely suggested. */
export const MAX_PLAN_TASKS = 12

/**
 * Feed a rejection back to the model, and make the attempt count visible.
 *
 * The validator's messages already say what to fix; what was missing was any
 * sense of repetition. A model that has been rejected three times keeps
 * re-proposing the same plan shape, so the third rejection is where telling it
 * to change strategy — narrow the scope, or ask — saves more time than
 * another round of errors.
 *
 * `measured` is the other half. A verify entry's `kind` is decided by the exit
 * code the Developer already recorded for it, and a rejection that says only
 * "already passes before any change" sends it back to `run_baseline` to find
 * out what it already measured — which in a real session was twenty-six
 * baseline runs across four proposals, twenty-five of them distinct commands,
 * because every rejection restarted the measurement from nothing.
 */
export function rejectPlan(
  messages: ChatMessage[],
  toolCallId: string,
  errors: readonly string[],
  attempt = 1,
  measured: readonly string[] = [],
): void {
  const header = attempt >= 3
    ? `Plan rejected (attempt ${attempt}). Re-reading these will not help — change approach: ` +
      'propose a smaller plan for the part you are sure about, or ask the user a specific question.'
    : attempt === 2
      ? `Plan rejected (attempt 2). Fix every point below in the next call:`
      : 'Plan rejected:'
  const body = `${header}\n- ${errors.join('\n- ')}`
  messages.push({
    role: 'tool',
    content:
      measured.length === 0
        ? body
        : `${body}\n\nYou already measured these. The kind follows the exit code — do not re-run them:\n${measured.join('\n')}`,
    tool_call_id: toolCallId,
  })
}

/**
 * The exit codes already recorded for the commands in a rejected plan, with the
 * kind each one has to carry.
 *
 * This is the decision the model was getting wrong, restated with the numbers it
 * had already collected: `proves-change` needs an exit that is not the expected
 * one, `regression-guard` needs the expected one. Only the commands in the plan
 * are listed, and only the ones with an observation, so it is short enough to
 * read and complete enough to act on.
 */
export function measuredBaselines(
  tasks: readonly PlannedTaskInput[],
  baselinesByCommand: ReadonlyMap<string, number>,
  projectDir: string,
): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const task of tasks) {
    for (const v of task.verify ?? []) {
      const key = baselineKey(v.command, v.args ?? [], v.cwd, projectDir)
      if (seen.has(key)) continue
      seen.add(key)
      const exit = baselinesByCommand.get(key)
      if (exit === undefined) continue
      const expected = v.expectExit ?? 0
      const kind = exit === expected ? 'regression-guard' : 'proves-change'
      // Not labelled by task: the same command in two tasks needs one kind
      // decision, and repeating it per task is how a plan ends up labelling the
      // same command two different ways.
      lines.push(`  exit ${exit}  ${v.command} ${(v.args ?? []).join(' ')}  → kind ${kind}`)
    }
  }
  return lines
}

/** The plan-wide shape decision, with the offenders named for the error. */
export function planShape(tasks: readonly PlannedTaskInput[]): {
  kind: 'structured' | 'flat' | 'mixed' | 'empty'
  offenders?: string
} {
  let structured: string[] = []
  let flat: string[] = []
  for (const task of tasks) {
    const shape = taskShape(task)
    if (shape === 'structured') structured.push(task.title)
    else if (shape === 'flat') flat.push(task.title)
  }
  if (structured.length > 0 && flat.length > 0) {
    return {
      kind: 'mixed',
      offenders: `context/edits/verify: ${structured.slice(0, 3).map(q).join(', ')}; flat: ${flat
        .slice(0, 3)
        .map(q)
        .join(', ')}`,
    }
  }
  if (structured.length > 0) return { kind: 'structured' }
  if (flat.length > 0) return { kind: 'flat' }
  return { kind: 'empty' }
}

/**
 * Build the evidence the validator checks against: every file read this turn,
 * and a baseline exit code for each verify entry the model actually ran.
 */
export function buildEvidence(
  filesRead: ReadonlyMap<string, string>,
  baselinesByCommand: ReadonlyMap<string, number>,
  tasks: readonly PlannedTaskInput[],
  projectDir: string,
): PlanEvidence {
  const baselines = new Map<string, number>()
  for (const task of tasks) {
    (task.verify ?? []).forEach((v, i) => {
      const exit = baselinesByCommand.get(baselineKey(v.command, v.args ?? [], v.cwd, projectDir))
      if (exit !== undefined) {
        baselines.set(`${task.id}#${i}`, exit)
      }
    })
  }
  return { filesRead, baselines }
}

/** Write harness observations (§1) onto the accepted plan: occurrences of each
 *  anchor in the file it was read from, and the baseline exit per verify entry. */
export function enrichHarnessEvidence(
  tasks: PlannedTask[],
  filesRead: ReadonlyMap<string, string>,
  baselinesByCommand: ReadonlyMap<string, number>,
  projectDir: string,
): void {
  for (const task of tasks) {
    for (const edit of task.edits ?? []) {
      if (edit.anchor) {
        const content = filesRead.get(edit.path)
        if (content !== undefined) {
          edit.anchorOccurrences = content.split(edit.anchor).length - 1
        }
      }
    }
    for (const v of task.verify ?? []) {
      const exit = baselinesByCommand.get(baselineKey(v.command, v.args ?? [], v.cwd, projectDir))
      if (exit !== undefined) {
        v.baselineExit = exit
      }
    }
  }
}
