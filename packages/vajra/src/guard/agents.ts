import { basename, join } from 'node:path'

/**
 * What a known coding agent needs beyond the project, so `vajra guard claude` works
 * without a list of flags. Each profile names only the agent's own state: never a
 * shared parent such as `~/.local`, `~/.config` or `~/.cache`, which hold other
 * programs' secrets.
 *
 * Paths that do not exist on this machine are skipped by the policy, so a profile
 * can list a location the agent only creates after it has been used.
 */
export interface AgentProfile {
  name: AgentName
  /** What a person types to start it. */
  commands: readonly string[]
  /** Where it keeps config, login and history, which it must be able to change. */
  write: (env: AgentEnv) => string[]
  /** Where it reads its configuration but has no reason to change it. */
  read: (env: AgentEnv) => string[]
  /** Said in the policy summary, for what a person should know about this profile. */
  note?: string
}

export type AgentName = 'claude' | 'opencode' | 'codex'

export interface AgentEnv {
  home: string
  env: Readonly<Record<string, string | undefined>>
}

/** An XDG directory: the variable when it is set to an absolute path, else the default under home. */
function xdg(e: AgentEnv, variable: string, fallback: string): string {
  const value = e.env[variable]
  return value && value.startsWith('/') ? value : join(e.home, fallback)
}

export const AGENTS: readonly AgentProfile[] = [
  {
    name: 'claude',
    commands: ['claude'],
    // CLAUDE_CONFIG_DIR moves everything, including the `.claude.json` that otherwise sits in home.
    write: e => {
      const dir = e.env.CLAUDE_CONFIG_DIR
      return dir
        ? [dir, join(e.home, '.cache', 'claude-cli-nodejs')]
        : [join(e.home, '.claude'), join(e.home, '.claude.json'), join(e.home, '.cache', 'claude-cli-nodejs')]
    },
    read: () => [],
    note: 'its install directory stays read-only, so it cannot rewrite itself. ~/.claude.json is updated in place, without the lock and temp file Claude would put in your home directory, which stays closed: run one session at a time',
  },
  {
    name: 'opencode',
    commands: ['opencode'],
    // `opencode debug paths` lists these: data (login, sessions), state, cache, and config.
    write: e => [
      join(xdg(e, 'XDG_DATA_HOME', '.local/share'), 'opencode'),
      join(xdg(e, 'XDG_STATE_HOME', '.local/state'), 'opencode'),
      join(xdg(e, 'XDG_CACHE_HOME', '.cache'), 'opencode'),
    ],
    read: e => [join(xdg(e, 'XDG_CONFIG_HOME', '.config'), 'opencode')],
    note: 'its config directory is read-only: an agent that could edit it could change its own permissions or add plugins',
  },
  {
    name: 'codex',
    commands: ['codex'],
    write: e => [e.env.CODEX_HOME && e.env.CODEX_HOME.startsWith('/') ? e.env.CODEX_HOME : join(e.home, '.codex')],
    read: () => [],
    note: 'untested: Codex was not installed where this profile was written, so the paths come from its documentation. It also applies a sandbox of its own, which stacks inside this one',
  },
]

export class UnknownAgentError extends Error {}

/** Shells, by name. A shell is where agents get started by hand, so it gets every profile. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh'])

/**
 * Which profiles apply. `choice` is the `--agent` value: a name forces that profile,
 * and `none` turns profiles off. Otherwise a shell, interactive or named, gets all of
 * them, since an agent is started from inside it after the sandbox is applied and
 * cannot be given more rights then. Any other command gets the profile of its own name.
 */
export function resolveAgents(command: readonly string[], choice: string | undefined, interactive: boolean): AgentProfile[] {
  if (choice === 'none') return []
  if (choice !== undefined) {
    const named = AGENTS.find(agent => agent.name === choice)
    if (!named) throw new UnknownAgentError(`--agent ${choice}: expected ${AGENTS.map(a => a.name).join(', ')} or none`)
    return [named]
  }
  const typed = command[0] ? basename(command[0]) : ''
  if (interactive || SHELLS.has(typed)) return [...AGENTS]
  return AGENTS.filter(agent => agent.commands.includes(typed))
}
