import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { findExecutable } from '../guard/launch.js'

/**
 * `vajra doctor --fix`: say what is wrong, show the exact commands that would fix it,
 * and run them only when the person agrees. Anything that needs root goes through
 * `sudo`, so the person sees the password prompt and can read what they are approving.
 */

/** What the diagnosis needs to know about this machine. Gathered once, so a test can describe any machine. */
export interface MachineState {
  landlockEnforced: boolean
  landlockDetail: string
  /** Where bwrap really is, after following links: an AppArmor profile is attached to that path. */
  bwrapPath: string | null
  bwrapWorks: boolean
  bwrapDetail: string
  /** `kernel.apparmor_restrict_unprivileged_userns`, or null when the kernel has no such setting. */
  apparmorRestrictsUserns: string | null
  /** `kernel.unprivileged_userns_clone` (Debian), or null. */
  unprivilegedUsernsClone: string | null
  /** `user.max_user_namespaces`, or null. */
  maxUserNamespaces: string | null
  hasApparmorParser: boolean
  packageManager: PackageManager | null
}

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'zypper'

/** One command. `input` is fed to its standard input, so a file can be written through `tee`. */
export interface Command {
  argv: string[]
  input?: string
  sudo: boolean
}

export interface Fix {
  title: string
  commands: Command[]
}

export interface Problem {
  id: 'landlock' | 'bubblewrap-missing' | 'bubblewrap-apparmor' | 'bubblewrap-userns-clone' | 'bubblewrap-max-userns' | 'bubblewrap-unknown'
  message: string
  /** Present when the commands can be run for the person; absent when they have to act themselves. */
  fix?: Fix
  /** What the person has to do when there is no fix to run. */
  manual?: string
}

export const PROFILE_PATH = '/etc/apparmor.d/vajra-bwrap'
const SYSCTL_PATH = '/etc/sysctl.d/60-vajra-userns.conf'

/** The AppArmor profile that lets only bubblewrap make a user namespace. */
export function bwrapProfile(bwrapPath: string): string {
  return ['abi <abi/4.0>,', 'include <tunables/global>', `${bwrapPath} flags=(unconfined) {`, '  userns,', '}', ''].join('\n')
}

const INSTALL: Record<PackageManager, string[]> = {
  apt: ['apt-get', 'install', '-y', 'bubblewrap'],
  dnf: ['dnf', 'install', '-y', 'bubblewrap'],
  pacman: ['pacman', '-S', '--noconfirm', 'bubblewrap'],
  zypper: ['zypper', '--non-interactive', 'install', 'bubblewrap'],
}

function sysctlFix(title: string, key: string, value: string): Fix {
  return {
    title,
    commands: [
      { argv: ['tee', SYSCTL_PATH], input: `${key} = ${value}\n`, sudo: true },
      { argv: ['sysctl', '-w', `${key}=${value}`], sudo: true },
    ],
  }
}

/** Work out what is wrong, in the order it has to be fixed. An empty list means the machine is ready. */
export function diagnose(state: MachineState): Problem[] {
  const problems: Problem[] = []

  if (!state.landlockEnforced) {
    problems.push({
      id: 'landlock',
      message: `file access cannot be confined: ${state.landlockDetail}`,
      manual: 'Landlock needs Linux 5.13 or newer with "landlock" in the active security modules. Check `cat /sys/kernel/security/lsm`; if it is missing, add `lsm=landlock,<the others listed>` to the kernel command line and reboot. Vajra cannot change this for you.',
    })
  }

  if (state.bwrapPath === null) {
    const manager = state.packageManager
    problems.push(manager
      ? { id: 'bubblewrap-missing', message: 'bubblewrap (bwrap) is not installed', fix: { title: `Install bubblewrap with ${manager}`, commands: [{ argv: INSTALL[manager], sudo: true }] } }
      : { id: 'bubblewrap-missing', message: 'bubblewrap (bwrap) is not installed', manual: 'Install the "bubblewrap" package with your distribution\'s package manager.' })
    return problems
  }

  if (!state.bwrapWorks) {
    if (state.apparmorRestrictsUserns === '1' && state.hasApparmorParser) {
      const path = state.bwrapPath
      problems.push({
        id: 'bubblewrap-apparmor',
        message: 'AppArmor stops programs from making the user namespace bubblewrap needs (kernel.apparmor_restrict_unprivileged_userns=1)',
        fix: {
          title: `Let only ${path} make user namespaces, through an AppArmor profile`,
          commands: [
            { argv: ['tee', PROFILE_PATH], input: bwrapProfile(path), sudo: true },
            { argv: ['apparmor_parser', '-r', PROFILE_PATH], sudo: true },
          ],
        },
      })
    } else if (state.unprivilegedUsernsClone === '0') {
      problems.push({ id: 'bubblewrap-userns-clone', message: 'the kernel does not allow unprivileged user namespaces (kernel.unprivileged_userns_clone=0)', fix: sysctlFix('Allow unprivileged user namespaces', 'kernel.unprivileged_userns_clone', '1') })
    } else if (state.maxUserNamespaces === '0') {
      problems.push({ id: 'bubblewrap-max-userns', message: 'user namespaces are switched off (user.max_user_namespaces=0)', fix: sysctlFix('Allow user namespaces', 'user.max_user_namespaces', '15000') })
    } else {
      problems.push({ id: 'bubblewrap-unknown', message: state.bwrapDetail, manual: 'Vajra does not recognise this cause. Run `bwrap --ro-bind / / true` and read what it says; the usual causes are a container that blocks user namespaces, or a security policy other than AppArmor.' })
    }
  }
  return problems
}

/** The commands as a person would type them, for display before anything runs. */
export function describeCommand(command: Command): string[] {
  const line = `${command.sudo ? 'sudo ' : ''}${command.argv.join(' ')}`
  if (command.input === undefined) return [line]
  return [`${line} <<'EOF'`, ...command.input.trimEnd().split('\n'), 'EOF']
}

export function readState(env: NodeJS.ProcessEnv = process.env): Omit<MachineState, 'landlockEnforced' | 'landlockDetail' | 'bwrapWorks' | 'bwrapDetail' | 'bwrapPath'> {
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf-8').trim()
    } catch {
      return null
    }
  }
  const pathValue = env.PATH ?? ''
  const manager = (['apt-get', 'dnf', 'pacman', 'zypper'] as const).find(name => findExecutable(name, pathValue) !== null)
  return {
    apparmorRestrictsUserns: read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
    unprivilegedUsernsClone: read('/proc/sys/kernel/unprivileged_userns_clone'),
    maxUserNamespaces: read('/proc/sys/user/max_user_namespaces'),
    hasApparmorParser: findExecutable('apparmor_parser', `${pathValue}:/sbin:/usr/sbin`) !== null && existsSync('/etc/apparmor.d'),
    packageManager: manager === undefined ? null : manager === 'apt-get' ? 'apt' : manager,
  }
}

export interface FixIO {
  write: (line: string) => void
  /** Ask a yes/no question. Resolves false when the person declines or there is nobody to ask. */
  confirm: (question: string) => Promise<boolean>
  run: (command: Command) => number
  /** Gather the machine's state again after a fix. */
  recheck: () => Problem[]
}

/** Run one fix, command by command, stopping at the first that fails. Returns whether all succeeded. */
function runFix(fix: Fix, io: FixIO): boolean {
  for (const command of fix.commands) {
    const status = io.run(command)
    if (status !== 0) {
      io.write(`  failed (exit ${status}): ${command.sudo ? 'sudo ' : ''}${command.argv.join(' ')}`)
      return false
    }
  }
  return true
}

/**
 * Walk through the problems: show each fix, ask, run it, and check again at the end.
 * Returns whether the machine is ready afterwards. Nothing runs without a yes.
 */
export async function guideFixes(problems: Problem[], io: FixIO): Promise<boolean> {
  if (problems.length === 0) {
    io.write('Nothing to fix.')
    return true
  }
  for (const problem of problems) {
    io.write('')
    io.write(`problem: ${problem.message}`)
    if (!problem.fix) {
      io.write(`  to do yourself: ${problem.manual}`)
      continue
    }
    io.write(`  fix: ${problem.fix.title}`)
    for (const command of problem.fix.commands) for (const line of describeCommand(command)) io.write(`    ${line}`)
    if (!(await io.confirm('  Run these commands?'))) {
      io.write('  skipped.')
      continue
    }
    if (runFix(problem.fix, io)) io.write('  done.')
  }
  io.write('')
  const remaining = io.recheck()
  if (remaining.length === 0) {
    io.write('ok: this machine can run vajra.')
    return true
  }
  io.write('Still not ready:')
  for (const problem of remaining) io.write(`  - ${problem.message}`)
  return false
}

/** Real commands: `sudo` for anything that needs root, with the terminal attached so its password prompt works. */
export function runCommand(command: Command): number {
  const [program, ...args] = command.sudo ? ['sudo', ...command.argv] : command.argv
  const result = spawnSync(program as string, args, {
    input: command.input,
    stdio: [command.input === undefined ? 'inherit' : 'pipe', command.input === undefined ? 'inherit' : 'ignore', 'inherit'],
  })
  return result.status ?? 1
}
