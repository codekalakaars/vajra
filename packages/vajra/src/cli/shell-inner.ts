#!/usr/bin/env node
import '@codekalakaars/vajra-sandbox/platform-guard'
import { basename } from 'node:path'
import { runGuarded } from '../guard/launch.js'
import { SHIM_DIR } from '../session/notice.js'
import { startWith } from '../session/resume.js'

// Runs inside the bubblewrap view. It applies Landlock and the seccomp filter and then
// starts the person's shell, so everything the shell starts is confined by all three.
const projectDir = process.argv[2]
const hiddenByView: unknown = JSON.parse(process.argv[3] ?? '[]')
const resumeWith: unknown = JSON.parse(process.argv[4] ?? '[]')
if (!projectDir) {
  process.stderr.write('vajra: the view was started without a project\n')
  process.exit(2)
}

// The person's own startup files are in their home directory, which stays closed to the shell, so
// reading them would only print a "Permission denied" on every start. Skip them, and say in the prompt
// that this shell is a Vajra shell.
const shell = process.env.SHELL || '/bin/sh'
const NO_STARTUP_FILES: Record<string, string[]> = { bash: ['--noprofile', '--norc'], zsh: ['-f'], fish: ['--no-config'] }
const flags = NO_STARTUP_FILES[basename(shell)] ?? []

// After a restart for new rules, the agent that was running is started again with its own "continue" option,
// and the person lands in the shell when it ends. A shell that cannot be told to do this just starts normally.
const resume = Array.isArray(resumeWith) ? resumeWith.filter((word): word is string => typeof word === 'string') : []
const resumed = resume.length > 0 ? startWith(shell, flags, resume) : null
if (resume.length > 0 && resumed === null) process.stderr.write(`vajra: ${basename(shell)} cannot be told to resume ${resume[0]}; start it yourself with: ${resume.join(' ')}\n`)

process.exitCode = await runGuarded({
  projectDir,
  command: [shell, ...(resumed ?? flags)],
  allowRead: [],
  allowWrite: [],
  hiddenByView: Array.isArray(hiddenByView) ? hiddenByView.filter((path): path is string => typeof path === 'string') : [],
  explainPolicyFile: false,
  launcherDirs: [SHIM_DIR],
  dryRun: false,
  quiet: true,
  env: { ...process.env, PS1: 'vajra:\\w\\$ ' },
  write: line => process.stderr.write(`${line}\n`),
})
