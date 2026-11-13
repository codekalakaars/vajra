import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { POLICY_FILE } from './project-policy.js'

/** What a path is on this machine, after following symlinks; `null` when it does not exist. */
export interface PathProbe {
  real: string
  isDir: boolean
}

export interface AgentGrant {
  name: string
  read: readonly string[]
  write: readonly string[]
  note?: string
}

export interface PolicyInput {
  /** The project, as a real path. The command may do anything inside it. */
  projectDir: string
  home: string | null
  /** The value of PATH. */
  path: string
  /** The private temporary directory made for this run. */
  tmpDir: string
  /** The directory the command's real file is in, after following symlinks, so a launcher symlink into an install directory still runs. */
  commandDir?: string | null
  /** The install directories of the agents granted here, so each can start from a shell, as the command does. */
  agentCommandDirs?: readonly string[]
  /** Known agents' own state: granted when it exists, silently skipped when it does not. */
  agents: readonly AgentGrant[]
  /** Extra paths the person asked to make readable and executable. */
  allowRead: readonly string[]
  /** Extra paths the person asked to make writable. */
  allowWrite: readonly string[]
  probe: (path: string) => PathProbe | null
}

export interface GuardPolicy {
  /** Paths the command may read and run programs from. */
  readExecute: string[]
  /** Paths the command may read and write. */
  readWrite: string[]
  /** One line per grant, for a person to read before the command starts. */
  summary: string[]
}

/**
 * Terminal and null devices a shell needs. The native layer already grants
 * /dev/null, /dev/urandom and /dev/random; these are what an interactive
 * program asks for on top.
 */
const DEVICES = ['/dev/tty', '/dev/zero', '/dev/full', '/dev/ptmx', '/dev/pts']

/** Read-only places a tool commonly needs beyond /usr, /bin, /lib and /etc, which the addon grants itself. */
const SYSTEM_READ = ['/opt', '/run/systemd/resolve']

/**
 * Tool managers that live directly under the home directory and are safe to open
 * whole, so a `shims` or `bin` directory inside one can reach the rest of its
 * install. The list is explicit, not "anything under home": `~/.cargo` holds a
 * registry token and `~/.local` holds keyrings, and neither is on it.
 */
const TOOLCHAIN_HOMES = new Set(['.pyenv', '.nvm', '.rbenv', '.nodenv', '.goenv', '.asdf', '.volta', '.fnm', '.rustup', '.sdkman'])

/** Directories whose programs sit beside the files they load. */
const LAUNCHER_DIRS = new Set(['bin', 'shims'])

export class GuardPolicyError extends Error {}

/** A path is made absolute against `cwd` and must exist, because a typo that grants nothing is silent. */
function requireExisting(flag: string, raw: string, probe: PolicyInput['probe']): PathProbe {
  const found = probe(isAbsolute(raw) ? raw : resolve(raw))
  if (!found) throw new GuardPolicyError(`${flag} ${raw}: no such file or directory`)
  if (found.real === '/') throw new GuardPolicyError(`${flag} /: that would grant the whole machine`)
  return found
}

/**
 * The directories PATH names are where the command's programs live, so they must be
 * readable and runnable. A `bin` or `shims` directory usually sits beside the files
 * its programs load (an nvm Node keeps `lib/node_modules` next to `bin`), so its
 * parent is granted too. Directly under the home directory that is only done for
 * the tool managers named above: `~/.local/bin` must not open `~/.local/share`.
 */
function pathGrants(input: PolicyInput): string[] {
  const grants: string[] = []
  const home = input.home
  for (const entry of input.path.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue
    const found = input.probe(entry)
    if (!found || !found.isDir || found.real === '/' || found.real === home) continue
    grants.push(found.real)
    if (!LAUNCHER_DIRS.has(basename(found.real))) continue
    const parent = dirname(found.real)
    const underHome = home !== null && dirname(parent) === home
    const tooBroad = parent === '/' || parent === home || (underHome && !TOOLCHAIN_HOMES.has(basename(parent)))
    if (!tooBroad) grants.push(parent)
  }
  return grants
}

/**
 * Decide what a confined command may touch. Pure: the machine is read through
 * `probe`, so the same input gives the same policy and a test needs no real
 * directories.
 *
 * Everything not granted here, or by the addon's own system grants, is denied: the
 * home directory, other projects, ssh keys, and the shared /tmp.
 */
export function buildGuardPolicy(input: PolicyInput): GuardPolicy {
  const readExecute = new Set<string>()
  const readWrite = new Set<string>([input.tmpDir])
  const summary: string[] = [`project   ${input.projectDir}  (rights from ${POLICY_FILE}, see below)`, `temp      ${input.tmpDir}  (private to this run, removed at exit)`]

  const runDirs = [input.commandDir, ...(input.agentCommandDirs ?? [])].filter((dir): dir is string => !!dir && dir !== '/' && dir !== input.home)
  for (const path of [...pathGrants(input), ...runDirs, ...SYSTEM_READ]) {
    const found = input.probe(path)
    if (found) readExecute.add(found.real)
  }
  if (input.home) {
    for (const path of [`${input.home}/.gitconfig`, `${input.home}/.config/git`]) {
      const found = input.probe(path)
      if (found) readExecute.add(found.real)
    }
  }
  for (const path of DEVICES) {
    const found = input.probe(path)
    if (found) readWrite.add(found.real)
  }

  // Every profile's own directories. Shared between agents only if two profiles name the same path.
  const agentPaths = new Set<string>()
  const agentLines: string[] = []
  for (const agent of input.agents) {
    const granted: string[] = []
    for (const path of agent.read) {
      const found = input.probe(path)
      if (found && found.real !== '/') {
        readExecute.add(found.real)
        agentPaths.add(found.real)
        granted.push(`${found.real} (read)`)
      }
    }
    for (const path of agent.write) {
      const found = input.probe(path)
      if (found && found.real !== '/') {
        readWrite.add(found.real)
        agentPaths.add(found.real)
        granted.push(`${found.real} (write)`)
      }
    }
    agentLines.push(`agent     ${agent.name}: ${granted.join(', ') || 'none of its directories exist yet'}`)
    if (agent.note) agentLines.push(`          ${agent.note}`)
  }

  for (const raw of input.allowRead) readExecute.add(requireExisting('--allow-read', raw, input.probe).real)
  for (const raw of input.allowWrite) readWrite.add(requireExisting('--allow-write', raw, input.probe).real)

  summary.push(`read+run  ${readExecute.size} paths from PATH and the system${input.allowRead.length ? `, plus ${input.allowRead.length} you allowed` : ''}`)
  if (input.agents.length > 1) {
    summary.push(`agents    every known agent's own directories: one agent can read another's login. Start a shell with --agent <name> to give only one`)
  }
  summary.push(...agentLines)
  summary.push(`writable  ${[...readWrite].filter(p => p !== input.tmpDir && !DEVICES.includes(p) && !agentPaths.has(p)).join(', ') || 'nothing else beyond the project and the temp directory'}`)
  summary.push('denied    everything else, including the home directory and /tmp')

  // A grant inside the project would override the policy file, since the kernel adds
  // rights up. So those are dropped, and the person is told why.
  const inside = (path: string): boolean => path === input.projectDir || path.startsWith(`${input.projectDir}/`)
  const dropped = [...readExecute, ...readWrite].filter(inside)
  for (const path of dropped) {
    readExecute.delete(path)
    readWrite.delete(path)
  }
  if (dropped.length > 0) summary.push(`ignored   ${dropped.join(', ')}: inside the project, so ${POLICY_FILE} decides`)

  return { readExecute: [...readExecute], readWrite: [...readWrite], summary }
}
