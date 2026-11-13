import { realpathSync } from 'node:fs'
import { release } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { Command } from 'commander'
import { sandboxCapabilities, type SandboxCapabilities } from '@codekalakaars/vajra-sandbox'
import { probeBubblewrap, type BubblewrapStatus } from '../view/launch.js'
import { diagnose, guideFixes, readState, runCommand, type MachineState, type Problem } from './doctor-fix.js'

export const DOCTOR_EXIT_ENFORCED = 0
export const DOCTOR_EXIT_UNENFORCED = 1

export interface DoctorReport {
  /** The kernel can confine a process's file access, so a guarded shell would be guarded. */
  enforced: boolean
  lines: string[]
}

/**
 * What this machine can actually enforce, in words a person can act on.
 *
 * Confinement is the whole product, so this is the first thing to check: on a
 * kernel without Landlock a "guarded" shell would only look guarded.
 */
export function describeCapabilities(caps: SandboxCapabilities, kernel: string): DoctorReport {
  const enforced = caps.filesystem === 'enforced'
  const lines = [
    `kernel       ${kernel}`,
    `platform     ${caps.platform}`,
    `mechanism    ${caps.mechanism}${caps.abi === undefined ? '' : ` (ABI ${caps.abi})`}`,
    `filesystem   ${caps.filesystem}`,
    `details      ${caps.details}`,
    '',
    enforced
      ? 'ok: file access can be confined on this machine.'
      : 'not ok: this machine cannot confine file access, so a guarded shell would not be guarded.',
  ]
  return { enforced, lines }
}

/** What this machine is like right now: Landlock, bubblewrap and the settings that decide whether it can run. */
function gatherState(): MachineState {
  const caps = sandboxCapabilities()
  const view = probeBubblewrap()
  return {
    landlockEnforced: caps.filesystem === 'enforced',
    landlockDetail: caps.details,
    bwrapPath: view.path === null ? null : realpathSync(view.path),
    bwrapWorks: view.works,
    bwrapDetail: view.detail,
    ...readState(),
  }
}

export interface Checklist {
  /** Everything `vajra` needs is in place. */
  ready: boolean
  lines: string[]
}

/** One row of the checklist, with a continuation line for a second sentence under the same item. */
function row(ok: boolean, name: string, text: string, more: string | undefined, paint: (ok: boolean, text: string) => string): string[] {
  const head = `  ${paint(ok, ok ? '✔' : '✘')}  ${name.padEnd(12)}${text}`
  return more === undefined ? [head] : [head, `  ${' '.repeat(3)}${' '.repeat(12)}${more}`]
}

/**
 * The report as a checklist: what Vajra needs, whether each is there, and for anything missing
 * the cause and what to do. Plain text, with color only when the caller asks for it.
 */
export function renderChecklist(
  caps: SandboxCapabilities,
  kernel: string,
  view: BubblewrapStatus,
  problems: readonly Problem[],
  color = false,
): Checklist {
  const paint = (ok: boolean, text: string): string => (color ? `\x1b[${ok ? 32 : 31}m${text}\x1b[0m` : text)
  const landlockOk = caps.filesystem === 'enforced'
  const lines = ['Vajra doctor', '']
  lines.push(...row(true, 'Kernel', `${kernel} (${caps.platform})`, undefined, paint))
  lines.push(...row(landlockOk, 'Landlock', landlockOk ? `enforced${caps.abi === undefined ? '' : ` (ABI ${caps.abi})`}` : 'not enforced', landlockOk ? undefined : caps.details, paint))
  if (view.works) lines.push(...row(true, 'Bubblewrap', `works (${view.path})`, undefined, paint))
  else if (view.path === null) lines.push(...row(false, 'Bubblewrap', 'not installed', undefined, paint))
  else lines.push(...row(false, 'Bubblewrap', `installed at ${view.path}, but it cannot build the view`, view.reason ?? undefined, paint))

  const ready = landlockOk && view.works && problems.length === 0
  lines.push('')
  if (ready) {
    lines.push('ok: Vajra can run on this machine.')
    return { ready, lines }
  }
  lines.push('not ok: Vajra cannot open a shell on this machine yet.')
  for (const problem of problems) {
    lines.push('', `  Cause   ${problem.message}`)
    lines.push(problem.fix ? `  Fix     ${problem.fix.title}` : `  To do   ${problem.manual}`)
  }
  if (problems.some(problem => problem.fix)) lines.push('', 'Run `vajra doctor --fix` to apply the fixes. It shows each command and asks first.')
  return { ready, lines }
}

/** Ask on the terminal. With no terminal there is nobody to agree, so the answer is no and nothing runs. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`${question} (no terminal to ask on, so not running)`)
    return false
  }
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await input.question(`${question} [y/N] `)).trim())
  } finally {
    input.close()
  }
}

/** `vajra doctor`: report whether this machine can run Vajra. `--fix` walks through the repairs. */
export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Check whether this machine can run Vajra')
    .option('--fix', 'Show what is wrong and offer to run the commands that fix it (asks before each; may use sudo)')
    .addHelpText('after', '\nExit codes:\n  0  Vajra can run here (with --fix: and nothing is left to fix)\n  1  it cannot\n')
    .action(async (options: { fix?: boolean }) => {
      const color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
      const show = (): Checklist => {
        const checklist = renderChecklist(sandboxCapabilities(), release(), probeBubblewrap(), diagnose(gatherState()), color)
        for (const line of checklist.lines) console.log(line)
        return checklist
      }
      const first = show()
      if (!options.fix) {
        process.exitCode = first.ready ? DOCTOR_EXIT_ENFORCED : DOCTOR_EXIT_UNENFORCED
        return
      }
      if (first.ready) return
      console.log('')
      const ready = await guideFixes(diagnose(gatherState()), {
        write: line => console.log(line),
        confirm,
        run: runCommand,
        recheck: () => diagnose(gatherState()),
      })
      process.exitCode = ready ? DOCTOR_EXIT_ENFORCED : DOCTOR_EXIT_UNENFORCED
    })
}
