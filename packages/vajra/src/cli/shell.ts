import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { resolveAgents } from '../guard/agents.js'
import { loadProjectPolicy } from '../guard/project-policy.js'
import { policyText } from '../panel/rights.js'
import { startPanel } from '../panel/server.js'
import { SHIM_DIR, writeNotice } from '../session/notice.js'
import { findAgent, resumeCommand, type RunningAgent } from '../session/resume.js'
import { bubblewrapArgs, probeBubblewrap } from '../view/launch.js'
import { planView } from '../view/plan.js'

/**
 * Open a shell on the current project, confined three ways:
 *
 *  - bubblewrap decides what exists: `read: false` paths are not in the view and the
 *    project is read-only except where `.vajra.json` says otherwise;
 *  - Landlock, applied inside the view, decides what may be read, written, created and
 *    removed, and blocks everything outside the project and the system paths;
 *  - seccomp closes the calls that would get around the other two.
 *
 * None of these can change while the shell runs. To change the rules, the control page edits
 * `.vajra.json` and asks for a restart: the shell is stopped, started again from the new file,
 * and an agent that was running in it is started again with its own "continue" option.
 */

interface Ended {
  restart: boolean
  resume: string[] | null
  code: number
}

interface Session {
  pid: number
  /** The policy text this shell was started from. */
  applied: string
  finished: Promise<Ended>
  requestRestart: () => Promise<void>
}

const processGone = (pid: number): boolean => !existsSync(`/proc/${pid}`)

async function waitGone(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (processGone(pid)) return true
    await delay(100)
  }
  return processGone(pid)
}

/** An agent killed mid-screen can leave the terminal in a full-screen or raw mode. */
function resetTerminal(): void {
  if (!process.stdout.isTTY) return
  process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[0m\r\n')
  // The shell that just ended was the terminal's foreground group, so this process is now in the background, and
  // changing the terminal from there stops it (the shell reports "Stopped") or fails with an I/O error. A program that
  // ignores SIGTTOU is allowed, and `stty` inherits that.
  spawnSync('sh', ['-c', "trap '' TTOU TTIN; exec stty sane"], { stdio: 'inherit' })
}

function startSession(projectRoot: string, bwrap: string, resume: string[] | null): Session {
  const applied = policyText(projectRoot)
  // A policy the view cannot express exactly is refused here, before anything starts.
  const policy = loadProjectPolicy(projectRoot)
  const view = planView(projectRoot, policy.config, policy.create)

  const inner = [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'shell-inner.js'), projectRoot, JSON.stringify(view.hidden), JSON.stringify(resume ?? [])]
  // A shell gets every agent's profile, so the directories each keeps its login and history in are writable too.
  // Only those that exist, as in the guard: a path that is not there cannot be mounted.
  const home = process.env.HOME ?? homedir()
  const binds = resolveAgents([], undefined, true)
    .flatMap(profile => profile.write({ home, env: process.env }))
    .filter(path => existsSync(path))
    .map(path => realpathSync(path))

  process.stderr.write(`vajra: shell on ${projectRoot}\n`)
  if (!policy.fromFile) process.stderr.write('vajra: no .vajra.json here, so the project is read-only. Add rules on the control page, or see docs/project-policy.md\n')
  if (view.hidden.length > 0) process.stderr.write(`vajra: hidden: ${view.hidden.join(', ')}\n`)
  if (view.writable.length > 0) process.stderr.write(`vajra: writable: ${view.writable.join(', ')}\n`)
  if (view.creatable.length > 0) process.stderr.write(`vajra: new files allowed in: ${view.creatable.join(', ')}\n`)
  if (resume) process.stderr.write(`vajra: resuming ${resume[0]}\n`)
  process.stderr.write('vajra: the network is not restricted. Type exit to leave.\n')

  // The notice to the agent, and the launchers that hand it over. Made for each session, so it names the rules this shell has.
  const shims = mkdtempSync(join(tmpdir(), 'vajra-shims-'))
  chmodSync(shims, 0o700)
  writeNotice(shims, { writable: view.writable, creatable: view.creatable, hidden: view.hidden })

  const shell: ChildProcess = spawn(bwrap, bubblewrapArgs({ projectRoot, view, command: inner, binds, readOnlyMounts: [{ source: shims, dest: SHIM_DIR }] }), {
    stdio: 'inherit',
    env: { ...process.env, VAJRA: '1', VAJRA_NOTICE_FILE: `${SHIM_DIR}/notice.md`, PATH: `${SHIM_DIR}:${process.env.PATH ?? ''}` },
  })
  let restarting = false
  let agent: RunningAgent | null = null

  const finished = new Promise<Ended>((resolve, reject) => {
    shell.once('error', reject)
    shell.once('exit', (code, signal) => {
      rmSync(shims, { recursive: true, force: true })
      resolve({ restart: restarting, resume: agent ? resumeCommand(agent.name) : null, code: code ?? (signal ? 128 : 1) })
    })
  })

  const requestRestart = async (): Promise<void> => {
    if (restarting || shell.pid === undefined) return
    restarting = true
    agent = findAgent(shell.pid)
    // Ask the agent first, so it can finish writing its session before everything is stopped.
    if (agent) {
      process.kill(agent.pid, 'SIGTERM')
      await waitGone(agent.pid, 4000)
    }
    shell.kill('SIGTERM')
    if (!(await waitGone(shell.pid, 3000))) shell.kill('SIGKILL')
  }

  return { pid: shell.pid ?? 0, applied, finished, requestRestart }
}

/** Ask the desktop to open a page. False when there is no way to, so the address is printed instead. */
async function openBrowser(url: string): Promise<boolean> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.BROWSER) return false
  return new Promise<boolean>(resolve => {
    const opener = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
    const timer = setTimeout(() => resolve(true), 3000)
    opener.once('error', () => { clearTimeout(timer); resolve(false) })
    opener.once('exit', code => { clearTimeout(timer); resolve(code === 0) })
    opener.unref()
  })
}

export async function runProtectedShell(options: { browser?: boolean } = {}): Promise<void> {
  const projectRoot = realpathSync(process.cwd())

  // An unavailable view is a refusal, never a quieter shell: a shell that looks confined and is not is worse than none.
  const bubblewrap = probeBubblewrap()
  if (!bubblewrap.works || !bubblewrap.path) {
    throw new Error(`${bubblewrap.detail}\nVajra will not open a shell it cannot confine. Run \`vajra doctor --fix\`.`)
  }

  let current: Session | undefined
  const panel = await startPanel({
    projectRoot,
    appliedPolicy: () => current?.applied ?? '',
    agent: () => (current ? findAgent(current.pid)?.name ?? null : null),
    onApply: () => { void current?.requestRestart() },
  })

  // The terminal sends Ctrl-C to the whole foreground group, so the shell gets it itself.
  const ignoreInterrupt = () => {}
  // Never signal pid 0: that is this whole process group.
  const stop = (signal: NodeJS.Signals) => () => { if (current && current.pid > 0) process.kill(current.pid, signal) }
  process.on('SIGINT', ignoreInterrupt)
  process.on('SIGTERM', stop('SIGTERM'))
  process.on('SIGHUP', stop('SIGHUP'))

  try {
    const opened = options.browser !== false && await openBrowser(panel.browserUrl)
    process.stderr.write(opened
      ? 'vajra: control page opened in your browser\n'
      : `vajra: control page (open it in a browser): ${panel.browserUrl}\n`)

    let resume: string[] | null = null
    for (;;) {
      current = startSession(projectRoot, bubblewrap.path, resume)
      const ended = await current.finished
      if (!ended.restart) {
        process.exitCode = ended.code
        return
      }
      resetTerminal()
      process.stderr.write('vajra: rules changed, restarting the shell\n')
      resume = ended.resume
    }
  } finally {
    process.removeListener('SIGINT', ignoreInterrupt)
    await panel.close()
  }
}
