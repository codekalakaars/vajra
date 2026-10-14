import { Command } from 'commander'
import { KNOWN_AGENTS, runGuarded } from '../guard/launch.js'

const collect = (value: string, previous: string[]): string[] => [...previous, value]

/** `vajra guard [options] [--] [command...]`: run a command, or a shell, confined to a project. */
export function guardCommand(): Command {
  return new Command('guard')
    .description('Run a command, or your shell, confined to a project directory')
    .argument('[command...]', 'The command and its arguments (default: your shell)')
    .passThroughOptions()
    .option('-d, --dir <dir>', 'The project: what the command may do in it is set by .vajra.json', '.')
    .option('--allow-read <path>', 'Also let the command read and run files under this path (repeatable)', collect, [])
    .option('--allow-write <path>', 'Also let the command read and write under this path (repeatable)', collect, [])
    .option('--write <path>', 'Let the command change and create files in this project path: a folder ends in /  (repeatable)', collect, [])
    .option('--delete <path>', 'Let the command remove what is directly in this project folder (repeatable)', collect, [])
    .option('--deny-read <path>', 'Keep the command from reading this project path (repeatable)', collect, [])
    .option('--agent <name>', `Allow a known agent's own state: ${KNOWN_AGENTS.join(', ')}, or none (default: every agent for a shell, the command's own agent otherwise)`)
    .option('--dry-run', 'Print what would be allowed and stop, confining nothing')
    .option('-q, --quiet', 'Do not print the policy before the command starts')
    .addHelpText(
      'after',
      `
Everything outside the project is denied except the system programs and libraries,
the directories on PATH, a private temporary directory for this run, and what you
allow. That includes your home directory (so ~/.ssh, ~/.aws and other projects),
and the shared /tmp. A tool that needs its own state, such as an agent's config
directory, is recognised by name: "vajra guard -- claude" allows exactly the
directories Claude Code keeps its login, settings and history in, and nothing
else. Known agents: claude, opencode, codex. Others need --allow-write:

  vajra guard                       a shell, with every agent's own directories
  vajra guard --agent claude        a shell, with only claude's directories
  vajra guard -- claude             claude alone, confined
  vajra guard --allow-write ~/.mytool -- mytool

Inside the project, what the command may read, write and delete is set by
.vajra.json in the project root. Without one the project is read-only. The
options --write, --delete and --deny-read add rules for this run, and the guard
prints the .vajra.json that would keep them. A file with read: false keeps its
content from the command, but its name still shows.

  vajra guard --write src/ --write README.md

Not covered: the network is not restricted, and the environment is passed through
as is.

Exit codes: the command's own, except
  125  guard could not start (bad option, no such project, cannot confine here)
  126  the command could not be run
  127  the command was not found
`,
    )
    .action(async (command: string[], options: { dir: string; allowRead: string[]; allowWrite: string[]; write: string[]; delete: string[]; denyRead: string[]; agent?: string; dryRun?: boolean; quiet?: boolean }) => {
      process.exitCode = await runGuarded({
        projectDir: options.dir,
        command,
        allowRead: options.allowRead,
        allowWrite: options.allowWrite,
        policy: { write: options.write, delete: options.delete, denyRead: options.denyRead },
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        dryRun: Boolean(options.dryRun),
        quiet: Boolean(options.quiet),
        write: line => process.stderr.write(`${line}\n`),
      })
    })
}
