import { readFileSync, readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { AGENTS, type AgentName } from '../guard/agents.js'

/**
 * When the rules change the shell is restarted, and an agent that was running in it is started
 * again with its own "continue the last session" option, so the person carries on where they were.
 * Each agent keeps its sessions in its own state directory, which the shell can reach, so the
 * restarted agent finds the conversation it had.
 */

export interface RunningAgent {
  name: AgentName
  /** The agent's process on this machine (not the number it has inside the shell). */
  pid: number
}

/** What to type to carry on the last session. Only the agent's name and this option: the other flags it was started with are not carried over. */
const RESUME: Record<AgentName, string[]> = {
  claude: ['claude', '--continue'],
  opencode: ['opencode', '--continue'],
  // Untested: Codex was not installed where this was written, so this is from its documentation.
  codex: ['codex', 'resume', '--last'],
}

export function resumeCommand(agent: AgentName): string[] {
  return [...RESUME[agent]]
}

/** Program names that run a script, so the agent's name is the next word. */
const LAUNCHERS = new Set(['node', 'bun', 'deno', 'nodejs'])

/** Which agent a command line starts, or null. */
export function agentOf(argv: readonly string[]): AgentName | null {
  const first = argv[0] ? basename(argv[0]) : ''
  const named = LAUNCHERS.has(first) && argv[1] ? basename(argv[1]).replace(/\.(m?js|cjs|ts)$/, '') : first
  return AGENTS.find(agent => agent.commands.includes(named))?.name ?? null
}

interface Proc {
  pid: number
  parent: number
  group: number
  /** The foreground process group of the terminal this process is on, or -1. */
  foreground: number
  argv: string[]
}

function readProc(root: string, pid: number): Proc | null {
  try {
    const stat = readFileSync(`${root}/${pid}/stat`, 'utf-8')
    // The name is in parentheses and can hold spaces and brackets, so fields are counted from the last ")".
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const argv = readFileSync(`${root}/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean)
    return { pid, parent: Number(rest[1]), group: Number(rest[2]), foreground: Number(rest[5]), argv }
  } catch {
    return null
  }
}

/**
 * The agent running in the shell below `rootPid`, if there is one. When several are running, the one in
 * the terminal's foreground is the one the person is using; otherwise the newest.
 */
export function findAgent(rootPid: number, procRoot = '/proc'): RunningAgent | null {
  const all: Proc[] = []
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue
    const proc = readProc(procRoot, Number(entry))
    if (proc) all.push(proc)
  }
  const below = new Set<number>([rootPid])
  for (let grew = true; grew;) {
    grew = false
    for (const proc of all) {
      if (!below.has(proc.pid) && below.has(proc.parent)) {
        below.add(proc.pid)
        grew = true
      }
    }
  }
  const found = all
    .filter(proc => proc.pid !== rootPid && below.has(proc.pid))
    .flatMap(proc => {
      const name = agentOf(proc.argv)
      return name ? [{ name, pid: proc.pid, inForeground: proc.group === proc.foreground }] : []
    })
  const chosen = found.filter(agent => agent.inForeground).at(-1) ?? found.at(-1)
  return chosen ? { name: chosen.name, pid: chosen.pid } : null
}

/** One word of a command, quoted for a POSIX shell. */
export function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** The shell's own arguments to run `command` first and then stay in a shell, or null for a shell that cannot be told this way. */
export function startWith(shell: string, flags: readonly string[], command: readonly string[]): string[] | null {
  if (!['bash', 'zsh', 'sh', 'dash'].includes(basename(shell))) return null
  const again = [shell, ...flags, '-i'].map(quote).join(' ')
  return [...flags, '-i', '-c', `${command.map(quote).join(' ')}; exec ${again}`]
}
