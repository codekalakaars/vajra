/**
 * Run the screen on a pty, and make sure it does not outlive the script.
 *
 * `script(1)` exists to give the renderer a terminal, and it does that by forking
 * a shell to run the command in. So the process tree is three deep — this
 * module, `script`, and then the thing you actually wanted — and signalling the
 * pid we spawned only reaches the middle one. Killing `script` leaves the
 * renderer running: an orphaned `bun` holding a pty, drawing frames nobody
 * reads, for as long as the machine stays up.
 *
 * Two hundred runs of a leaking test script is what it takes to notice, which is
 * the argument for putting the fix somewhere it cannot be forgotten: every
 * script gets its process group here, and the group is torn down on the way out
 * of the script however the script ends.
 *
 * The process group alone is not enough, which is the second half of the lesson.
 * `script` puts its child in a session of its own — that is how the child
 * acquires the pty as a controlling terminal — so the renderer sits in a
 * *different* group from the process we spawned, and `kill(-pid)` reaches only
 * the middle of the tree. A group kill alone leaks exactly as silently as no
 * kill at all. So the tree is walked through /proc and killed deepest first.
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * A screen on a pty.
 *
 * @typedef {object} Pty
 * @property {import('node:child_process').ChildProcess} child
 * @property {() => void} close  the whole process group: `script`, its shell, and the screen
 * @property {Promise<number|null>} exited  for a caller that wants to watch a child die on its own
 */

const SIGKILL = 'SIGKILL'

/** Direct children of a pid, from /proc, or [] where there are none. */
const childPids = (pid) => {
  try {
    // /proc/<pid>/task/<pid>/children is the cheapest source and needs no
    // parsing, but it is a kernel option and not always built. The stat scan
    // below is the fallback and is always there.
    const listed = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
    if (listed) return listed.split(/\s+/).map(Number)
  } catch {
    /* fall through to the scan */
  }
  const out = []
  let entries = []
  try {
    entries = readdirSync('/proc')
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // Field 4 of /proc/<pid>/stat is the parent. The comm field can contain
      // spaces and parentheses, so the fields after the closing one are the
      // ones that can be trusted.
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (tail[1] === String(pid)) out.push(Number(entry))
    } catch {
      /* the process exited between the listing and the read */
    }
  }
  return out
}

/** Every descendant of a pid, deepest last, so killing it cannot re-parent. */
const descendants = (pid, out = []) => {
  for (const child of childPids(pid)) descendants(child, out)
  out.push(pid)
  return out
}

/**
 * @param {object} options
 * @param {string} options.command   the command to run under `script`, e.g. `bun src/main.tsx`
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} options.env
 * @param {number} options.cols
 * @param {number} options.rows
 * @param {unknown[]} [options.stdio]  extra descriptors past stderr, as the fake-host scripts need
 * @returns {Pty}
 */

/**
 * Spawn `command` on a pty of the given size.
 *
 * The pty is `script -qfec` with the size inlined into the command it runs,
 * which is the only way to get a terminal whose rows and columns the renderer
 * actually reads: the size has to be set on the slave before the program starts,
 * and `stty` on the master is too late.
 */
export function spawnUi(options) {
  const { command, cwd, env, cols, rows, stdio = [] } = options
  const child = spawn(
    'script',
    ['-qfec', `stty rows ${rows} cols ${cols}; ${command}`, '/dev/null'],
    {
      cwd,
      // Its own process group. This is the whole fix: with a group, a negative
      // pid reaches every process in the tree, and a Ctrl-C at the terminal
      // reaches them too instead of stopping at `script`.
      detached: true,
      env,
      stdio: ['pipe', 'pipe', 'inherit', ...stdio],
    },
  )

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    // The whole tree, deepest first. Collected before anything is signalled: a
    // killed `script` re-parents its child to init, and after that there is no
    // path left from the pid we spawned to the renderer.
    for (const pid of descendants(child.pid)) {
      try {
        process.kill(pid, SIGKILL)
      } catch {
        /* already dead, or not ours to kill */
      }
    }
    // The group as well, for anything that joined it after the walk.
    try {
      process.kill(-child.pid, SIGKILL)
    } catch {
      /* the group is already gone */
    }
  }

  // However this script ends — a failed assertion, a Ctrl-C, an exception in a
  // test — the screen goes with it. Without this the leak only happens on the
  // runs that pass, which is the worst way round to have it.
  const onSignal = () => {
    close()
    process.exit(1)
  }
  process.once('exit', close)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const exited = new Promise(resolve => {
    child.once('exit', code => resolve(code))
  })

  return { child, close, exited }
}
