import { spawnSync } from 'node:child_process'
import { findExecutable } from '../guard/launch.js'
import type { ViewPlan } from './plan.js'

export interface BubblewrapStatus {
  /** Where bubblewrap is, or null when it is not installed. */
  path: string | null
  /** Whether it can build a view here: installed, and allowed to make the namespaces it needs. */
  works: boolean
  /** What to tell the person: the reason it does not work, or a note that it does. */
  detail: string
  /** What bubblewrap itself said when it failed, or null. */
  reason: string | null
}

/**
 * Try bubblewrap with the smallest view that uses the same namespaces as the real one.
 * An installed bubblewrap is not enough: Ubuntu 24.04 and later let an unprivileged
 * program make a user namespace only if AppArmor says so, and bubblewrap fails at the
 * first step when it does not.
 */
export function probeBubblewrap(pathValue: string = process.env.PATH ?? ''): BubblewrapStatus {
  const path = findExecutable('bwrap', pathValue)
  if (!path) return { path: null, works: false, detail: 'bubblewrap (bwrap) is not installed', reason: null }
  const tried = spawnSync(path, ['--ro-bind', '/', '/', '--unshare-pid', '--dev', '/dev', '--proc', '/proc', 'true'], { encoding: 'utf-8', timeout: 10_000 })
  if (tried.status === 0) return { path, works: true, detail: `bubblewrap at ${path} can build the view`, reason: null }
  const reason = (tried.stderr || tried.error?.message || `exit status ${tried.status}`).trim()
  return { path, works: false, detail: `bubblewrap at ${path} cannot build the view: ${reason}`, reason }
}

/**
 * The bubblewrap command line for a shell on a project.
 *
 * The machine is bound read-only as the base, then the pieces that must differ are
 * laid over it: a private /dev, /proc and /tmp, the writable places, and the project's own view. The
 * network is shared on purpose; Vajra does not restrict it.
 */
export function bubblewrapArgs(options: { projectRoot: string; view: ViewPlan; command: string[]; binds?: readonly string[]; readOnlyMounts?: readonly { source: string; dest: string }[] }): string[] {
  const { projectRoot, view, command, binds = [], readOnlyMounts = [] } = options
  const underTmp = projectRoot === '/tmp' || projectRoot.startsWith('/tmp/')
  return [
    '--die-with-parent',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    // The private /tmp would cover a project that lives in /tmp, so it is bound back before the view is laid on it.
    ...(underTmp ? ['--ro-bind', projectRoot, projectRoot] : []),
    // Places outside the project that the shell may write, such as an agent's own state. Landlock grants the same
    // paths, but a read-only mount refuses first, so each has to be mounted read-write here as well.
    ...binds.flatMap(path => ['--bind', path, path]),
    // Files Vajra puts in the shell, such as the notice for the agent. They are laid on the private /tmp.
    ...readOnlyMounts.flatMap(mount => ['--ro-bind', mount.source, mount.dest]),
    ...view.args,
    '--chdir', projectRoot,
    '--',
    ...command,
  ]
}
