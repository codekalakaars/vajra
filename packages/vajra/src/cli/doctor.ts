import { release } from 'node:os'
import { Command } from 'commander'
import { sandboxCapabilities, type SandboxCapabilities } from '@codekalakaars/vajra-sandbox'

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

/** `vajra doctor`: report whether this machine can enforce the sandbox. */
export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Check whether this machine can enforce the sandbox')
    .addHelpText('after', '\nExit codes:\n  0  file access can be confined\n  1  it cannot\n')
    .action(() => {
      const report = describeCapabilities(sandboxCapabilities(), release())
      for (const line of report.lines) console.log(line)
      process.exitCode = report.enforced ? DOCTOR_EXIT_ENFORCED : DOCTOR_EXIT_UNENFORCED
    })
}
