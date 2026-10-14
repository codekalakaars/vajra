import { spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  applySandbox,
  createSandboxConfig,
  sandboxCapabilities,
} from '@codekalakaars/vajra-sandbox'
import { AGENTS, resolveAgents, UnknownAgentError } from './agents.js'
import { buildGuardPolicy, type PathProbe } from './policy.js'
import { loadProjectPolicy, POLICY_FILE, PolicyFileError, type PolicyChanges, type ProjectPolicy } from './project-policy.js'

/** Exit codes of `vajra guard` itself. Anything else is the command's own. */
export const GUARD_EXIT_SETUP = 125

export const KNOWN_AGENTS = AGENTS.map(agent => agent.name)
export const GUARD_EXIT_NOT_EXECUTABLE = 126
export const GUARD_EXIT_NOT_FOUND = 127

export interface GuardOptions {
  projectDir: string
  /** The command and its arguments. Empty means the person's own shell. */
  command: string[]
  allowRead: string[]
  allowWrite: string[]
  /** `--agent`: a profile name, `none`, or undefined: a shell gets every profile, another command its own. */
  agent?: string
  /** Rules given on the command line: `--write`, `--delete` and `--deny-read`, added to the project's policy for this run. */
  policy?: PolicyChanges
  /** Print the policy and stop, without confining anything. */
  dryRun: boolean
  quiet: boolean
  write: (line: string) => void
  env?: NodeJS.ProcessEnv
}

function probe(path: string): PathProbe | null {
  try {
    const real = realpathSync(path)
    return { real, isDir: statSync(real).isDirectory() }
  } catch {
    return null
  }
}

/** Where a command name leads, looked up the way a shell would. `null` when nothing runnable is found. */
export function findExecutable(name: string, pathValue: string): string | null {
  const candidates = name.includes('/') ? [resolve(name)] : pathValue.split(delimiter).filter(isAbsolute).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Run by a helper process: poll until the guard's process is gone, then delete the
 * private temporary directory. Polling, not an event, because it must also fire
 * when the guard is killed and cannot say goodbye.
 */
const REMOVE_WHEN_GONE = `
const [pid, dir] = process.argv.slice(1)
const gone = () => { try { process.kill(Number(pid), 0); return false } catch (e) { return e.code === 'ESRCH' } }
const timer = setInterval(() => {
  if (!gone()) return
  clearInterval(timer)
  require('node:fs').rmSync(dir, { recursive: true, force: true })
}, 200)
`

/**
 * Run a command confined to a project, and return its exit code.
 *
 * The confinement is applied to this process before the command starts, and a
 * child inherits it and cannot lift it. This process is confined too, so it loads
 * everything it needs before applying and does nothing afterwards but wait,
 * forward signals and delete the temporary directory.
 *
 * It refuses to run where confinement cannot be enforced: a guard that only looks
 * like a guard is worse than none.
 */
export async function runGuarded(options: GuardOptions): Promise<number> {
  const { write } = options
  const env = options.env ?? process.env
  const project = probe(resolve(options.projectDir))
  if (!project?.isDir) {
    write(`vajra guard: project directory does not exist: ${options.projectDir}`)
    return GUARD_EXIT_SETUP
  }

  let projectPolicy: ProjectPolicy
  try {
    projectPolicy = loadProjectPolicy(project.real, options.policy)
  } catch (err) {
    if (!(err instanceof PolicyFileError)) throw err
    write(`vajra guard: ${err.message}`)
    return GUARD_EXIT_SETUP
  }

  const capabilities = sandboxCapabilities()
  if (capabilities.filesystem === 'unsupported') {
    write(`vajra guard: refusing to run unconfined: ${capabilities.details}`)
    return GUARD_EXIT_SETUP
  }
  if (capabilities.filesystem === 'partial') write(`vajra guard: warning: ${capabilities.details}`)

  const command = options.command.length > 0 ? options.command : [env.SHELL || '/bin/sh']
  const pathValue = env.PATH ?? ''
  const executable = findExecutable(command[0] as string, pathValue)
  if (!executable) {
    write(`vajra guard: command not found: ${command[0]}`)
    return GUARD_EXIT_NOT_FOUND
  }

  let profiles: ReturnType<typeof resolveAgents>
  try {
    profiles = resolveAgents(command, options.agent, options.command.length === 0)
  } catch (err) {
    if (!(err instanceof UnknownAgentError)) throw err
    write(`vajra guard: ${err.message}`)
    return GUARD_EXIT_SETUP
  }
  const home = env.HOME ?? homedir()

  const tmpDir = options.dryRun ? join(tmpdir(), 'vajra-guard-XXXXXX') : realpathSync(mkdtempSync(join(tmpdir(), 'vajra-guard-')))
  // Removing a directory needs write access to its parent, which is the shared /tmp
  // and is denied once confined. Until then this process can do it itself.
  let confined = false
  const cleanup = (): void => {
    if (!options.dryRun && !confined) rmSync(tmpDir, { recursive: true, force: true })
  }

  try {
    const policy = buildGuardPolicy({
      projectDir: project.real,
      home,
      agents: profiles.map(profile => ({ name: profile.name, read: profile.read({ home, env }), write: profile.write({ home, env }), ...(profile.note ? { note: profile.note } : {}) })),
      path: pathValue,
      tmpDir,
      commandDir: dirname(realpathSync(executable)),
      agentCommandDirs: profiles.flatMap(profile => profile.commands)
        .map(name => findExecutable(name, pathValue))
        .filter((found): found is string => found !== null)
        .map(found => dirname(realpathSync(found))),
      allowRead: options.allowRead,
      allowWrite: options.allowWrite,
      probe,
    })
    if (!options.quiet || options.dryRun) {
      write(`vajra guard: ${command.join(' ')}`)
      for (const line of policy.summary) write(`  ${line}`)
      for (const line of projectPolicy.lines) write(`  rights    ${line}`)
    }
    // Printed even when quiet: a project without the file, or with rules that exist only on this command line,
    // needs the person to save them, or the next run will not have them.
    if (!projectPolicy.fromFile || projectPolicy.changed) {
      write(projectPolicy.changed
        ? `vajra guard: these rules are only for this run. To keep them, save this as ${POLICY_FILE} in the project:`
        : `vajra guard: no ${POLICY_FILE} in the project, so it is read-only. To allow writes, pass --write, --delete or --deny-read; to keep the rules, save this as ${POLICY_FILE}:`)
      for (const line of projectPolicy.json.trimEnd().split('\n')) write(`  ${line}`)
    }
    if (options.dryRun) return 0

    // Started before confining, so it is not confined: it waits for this process to
    // end, however it ends, and removes the temporary directory.
    spawn(process.execPath, ['-e', REMOVE_WHEN_GONE, String(process.pid), tmpDir], { detached: true, stdio: 'ignore' }).unref()
    confined = true

    const config = createSandboxConfig({
      projectDir: project.real,
      readExecutePaths: policy.readExecute,
      readWritePaths: policy.readWrite,
    })
    const applied = applySandbox({
      projectDir: config.projectDir,
      readExecutePaths: [...config.readExecutePaths],
      readWritePaths: [...config.readWritePaths],
      permissions: projectPolicy.config,
    })
    if (!applied.enforced) {
      write('vajra guard: the sandbox was not enforced; refusing to run the command')
      return GUARD_EXIT_SETUP
    }
    for (const warning of applied.warnings) write(`vajra guard: warning: ${warning}`)

    return await new Promise<number>(done => {
      const child = spawn(executable, command.slice(1), {
        cwd: project.real,
        stdio: 'inherit',
        env: { ...env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir, VAJRA_GUARD: project.real },
      })
      // The terminal sends Ctrl-C to the whole foreground group, so the command gets
      // it itself; the guard must outlive it to report how it ended and clean up.
      const ignored = ['SIGINT', 'SIGQUIT'] as const
      for (const signal of ignored) process.on(signal, () => {})
      for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal))
      child.on('error', err => {
        write(`vajra guard: could not start ${command[0]}: ${err.message}`)
        done(GUARD_EXIT_NOT_EXECUTABLE)
      })
      child.on('exit', (code, signal) => {
        const number = signal ? (({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal] ?? 0) : 0
        done(code ?? 128 + number)
      })
    })
  } catch (err) {
    write(`vajra guard: ${err instanceof Error ? err.message : String(err)}`)
    return GUARD_EXIT_SETUP
  } finally {
    cleanup()
  }
}
