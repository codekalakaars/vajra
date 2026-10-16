import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A message to the agent inside the shell, so a refusal is understood as the policy and not as a fault to be
 * worked around. The kernel's own words for a refused write, "Read-only file system" or "Permission denied",
 * say nothing about a policy, and an agent that reads them as a broken disk goes looking for a way past: remounting,
 * `sudo`, a writable copy in /tmp. This says plainly what is going on and what to do instead.
 *
 * It goes in through each agent's own instruction channel, by a small launcher placed first on PATH, because
 * the project is read-only and an agent's own files must not be edited. It is advice to the agent. The
 * enforcement is what stops the agent, and this only saves it the trouble of finding that out.
 */

/** Where the launchers and the notice appear inside the shell. */
export const SHIM_DIR = '/tmp/vajra-shims'

/** How many paths the notice lists before it says "and N more", so a large policy cannot flood the agent's context. */
const LIST_LIMIT = 30

export interface NoticeInput {
  /** Project-relative paths the shell may write. */
  writable: readonly string[]
  /** Project-relative paths that do not exist in the shell. */
  hidden: readonly string[]
}

/** A path as a quoted word, so a name with a newline or an instruction in it cannot pass for part of the notice. */
function word(path: string): string {
  const shown = path.length > 120 ? `${path.slice(0, 117)}...` : path
  return JSON.stringify(shown)
}

function list(paths: readonly string[]): string {
  const shown = paths.slice(0, LIST_LIMIT).map(word).join(', ')
  return paths.length > LIST_LIMIT ? `${shown}, and ${paths.length - LIST_LIMIT} more` : shown
}

export function buildNotice(input: NoticeInput): string {
  const lines = [
    'VAJRA SANDBOX NOTICE',
    '',
    'You are running inside a Vajra sandbox. It limits which files you can see and change.',
    '',
    'In this project:',
    input.writable.length > 0 ? `- You can write: ${list(input.writable)}.` : '- You cannot write anything in the project: it is all read-only.',
    ...(input.hidden.length > 0 ? [`- These do not exist for you: ${list(input.hidden)}.`] : []),
    '- Everything else is read-only.',
    '',
    'If a command fails with "Read-only file system" or "Permission denied" on a path in the project, or a path you expected is missing, that is this policy working. It is not a broken disk, mount or permission. `mount` showing a read-only drive is part of the same policy.',
    '',
    'Do not try to get around it. Do not use sudo, remount or mount, unshare, chmod or chown, ptrace, or any other trick. Do not copy the project somewhere else, such as /tmp, to edit it there, and do not search for another writable place. None of it will work, and it is not what the user wants.',
    '',
    'If you need to change something you cannot, stop. Say which path you needed and what you wanted to do with it, and ask the user to allow it on the Vajra control page. They can apply the change, and this session will be resumed with your conversation.',
    '',
  ]
  return lines.join('\n')
}

/** POSIX shell that finds the real program on PATH, skipping the directory this launcher is in. */
function finder(program: string): string {
  return `here=$(cd "$(dirname "$0")" && pwd)
real=
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -z "$dir" ] && continue
  [ "$dir" = "$here" ] && continue
  if [ -x "$dir/${program}" ] && [ ! -d "$dir/${program}" ]; then real="$dir/${program}"; break; fi
done
IFS=$old_ifs
[ -n "$real" ] || { echo "vajra: ${program} was not found on PATH" >&2; exit 127; }
`
}

const HEADER = '#!/bin/sh\n# Written by vajra for this session. It starts the real program with a notice about the sandbox.\n'

/**
 * What each launcher does to hand the notice to its agent. Only agents whose way of taking instructions was
 * checked against the agent itself are here, and each line says how.
 */
const LAUNCHERS: Record<string, string> = {
  // Claude Code appends text to its system prompt.
  claude: `${HEADER}${finder('claude')}exec "$real" --append-system-prompt "$(cat "$here/notice.md")" "$@"\n`,
  // opencode reads a list of instruction files from its config, and its config can be given in the environment.
  // A person's own setting is left as it is.
  opencode: `${HEADER}${finder('opencode')}if [ -z "\${OPENCODE_CONFIG_CONTENT:-}" ]; then
  OPENCODE_CONFIG_CONTENT="{\\"instructions\\":[\\"$here/notice.md\\"]}"
  export OPENCODE_CONFIG_CONTENT
fi
exec "$real" "$@"\n`,
}

// Codex takes a config override on the command line, and `developer_instructions` is placed in the prompt the model sees
// (checked with `codex debug prompt-input`). The value is a TOML string, written when the notice is, so the launcher only reads it.
LAUNCHERS.codex = `${HEADER}${finder('codex')}exec "$real" -c "developer_instructions=$(cat "$here/codex-instructions")" "$@"\n`
// pi appends text to its system prompt, as Claude Code does (`pi --help`).
LAUNCHERS.pi = `${HEADER}${finder('pi')}exec "$real" --append-system-prompt "$(cat "$here/notice.md")" "$@"\n`

export const LAUNCHED_AGENTS = Object.keys(LAUNCHERS)

/** The notice as a TOML basic string, which is what Codex's `-c` takes. JSON's escapes are TOML's, except that TOML also wants DEL escaped. */
export function tomlString(text: string): string {
  return JSON.stringify(text).replace(/\x7f/g, '\\u007f')
}

/**
 * Commands an agent reaches for when a write is refused. None of them can work inside the sandbox, but what
 * they print (`sudo: no new privileges`, `mount: permission denied`) reads like a setup problem to fix. These
 * answer with the same plain message as the notice. A shell that looks for a program by name finds these
 * first; one that runs `/usr/bin/sudo` by full path gets the kernel's own refusal, which is also a refusal.
 */
export const BLOCKED_COMMANDS = ['sudo', 'doas', 'su', 'mount', 'umount', 'fusermount', 'fusermount3', 'unshare', 'nsenter', 'chroot']

/** `mount` with no arguments, or only to ask for help, lists mounts and changes nothing, so it is passed on. */
const MOUNT_LISTS = '[ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && { [ "$1" = "-l" ] || [ "$1" = "--help" ] || [ "$1" = "-V" ]; }; }'

function blocker(command: string): string {
  const refuse = `cat "$(dirname "$0")/blocked.txt" >&2\necho "(you ran: ${command} $*)" >&2\nexit 1\n`
  if (command !== 'mount') return `${HEADER}${refuse}`
  return `${HEADER}if ${MOUNT_LISTS}; then\n${finder('mount').replace(/\n$/, '')}\nexec "$real" "$@"\nfi\n${refuse}`
}

/** What a blocked command says. It is the notice's point in a few lines, since it is read in the middle of a failing task. */
const BLOCKED_MESSAGE = [
  'vajra: that command is not available in this sandbox.',
  'This is a Vajra sandbox. A refusal such as "Read-only file system" or "Permission denied" is its policy working, not a fault, and it cannot be worked around.',
  'Do not try sudo, remount, copying the project elsewhere, or another writable path.',
  'Stop, tell the user which path you needed and what you wanted to do, and ask them to allow it on the Vajra control page. They can apply it and this session will resume.',
  '',
].join('\n')

/** Write the notice and the launchers into `dir`, which is mounted at SHIM_DIR inside the shell. */
export function writeNotice(dir: string, input: NoticeInput): void {
  const notice = buildNotice(input)
  writeFileSync(join(dir, 'notice.md'), notice, { mode: 0o444 })
  writeFileSync(join(dir, 'codex-instructions'), tomlString(notice), { mode: 0o444 })
  writeFileSync(join(dir, 'blocked.txt'), BLOCKED_MESSAGE, { mode: 0o444 })
  const scripts = { ...LAUNCHERS, ...Object.fromEntries(BLOCKED_COMMANDS.map(command => [command, blocker(command)])) }
  for (const [name, script] of Object.entries(scripts)) {
    const file = join(dir, name)
    writeFileSync(file, script)
    chmodSync(file, 0o555)
  }
}
