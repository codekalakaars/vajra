import { writeSync } from 'node:fs'

/**
 * Alternate screen buffer around the whole TUI — menu and sessions alike.
 *
 * Alt-screen is what gives the TUI a fixed canvas to repaint: nothing leaks
 * into terminal scrollback while the app runs, so the transcript viewport
 * (viewport.ts) is the only history, no repaint can ever scroll the terminal
 * underneath Ink, and returning from a session to the menu repaints over the
 * same buffer instead of appending a second copy of the menu below the first.
 *
 * The buffer is reference-counted: the menu enters once at startup and the
 * sessions nested inside it borrow it (depth 2), so there is exactly one
 * enter/leave pair for the whole run. The normal buffer comes back on every
 * exit path — process.exit from a force-quit and fatal signals included —
 * via three hooks: an explicit queued leave, the synchronous `exit` event
 * (stdout writes are not guaranteed there, fs.writeSync is), and the signal
 * handlers below.
 */

const ENTER = '\x1b[?1049h\x1b[H'
const LEAVE = '\x1b[?1049l'
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

let depth = 0
let hooksInstalled = false
/** Registered by the active surface (menu or session): stops Ink so its final frame cannot land after the leave. */
let teardown: (() => void) | null = null

function restoreSync(): void {
  if (depth === 0) return
  depth = 0
  try {
    writeSync(1, LEAVE)
  } catch {
    // Nothing sensible to do while the process is dying.
  }
}

export function setAltScreenTeardown(fn: (() => void) | null): void {
  teardown = fn
}

/**
 * Blank the buffer between surfaces: when a session ends and the menu comes
 * back, the menu's first frame would otherwise paint underneath the finished
 * session frame instead of over it.
 */
export function clearAltScreen(): void {
  if (depth === 0) return
  try {
    process.stdout.write(CLEAR)
  } catch {
    // Best-effort: a broken stdout is not worth crashing the menu over.
  }
}

/**
 * Fatal signals never reach the `exit` event — Node dies by the default
 * action instead — so the buffer has to be restored here too, or the next
 * shell prompt lands in a scrollback-less alt buffer with no mouse support.
 * The conventional 128+signo exit code keeps `echo $?` honest.
 *
 * Ordering is everything on this path:
 *  1. The active surface unmounts first, so its (clear + full frame) final
 *     write is queued ahead of the leave — otherwise that frame flushes into
 *     the restored normal buffer as one last dump of the whole screen.
 *  2. The leave goes through stdout's own queue for the same reason;
 *     writeSync would jump any still-pending writes.
 *  3. The handlers are standing listeners, not `once`: a once-handler
 *     unregisters when it fires, which makes signal-exit (Ink's own signal
 *     bridge) see "no other listeners", emit its exit, and re-raise the
 *     signal — killing the process before the queued leave flushes.
 */
function onFatalSignal(signal: 'SIGINT' | 'SIGHUP' | 'SIGTERM'): void {
  const code = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143
  if (depth === 0) {
    // Repeat signal, or a signal after the TUI already restored the
    // buffer: die deterministically instead of hanging.
    process.exit(code)
    return
  }
  depth = 0
  try {
    teardown?.()
  } catch {
    // Teardown is best-effort; the leave below still has to happen.
  }
  teardown = null
  let exited = false
  const exitNow = () => {
    if (exited) return
    exited = true
    process.exit(code)
  }
  // A blocked pipe must not keep the process alive forever.
  const fallback = setTimeout(exitNow, 500)
  try {
    process.stdout.write(LEAVE, () => {
      clearTimeout(fallback)
      exitNow()
    })
  } catch {
    clearTimeout(fallback)
    restoreSync()
    exitNow()
  }
}

export function enterAltScreen(): void {
  depth += 1
  if (depth > 1) return // Nested surface borrows the already-active buffer.
  if (!hooksInstalled) {
    hooksInstalled = true
    process.once('exit', restoreSync)
    // Registered before Ink renders, so these run ahead of Ink's signal-exit
    // bridge — but standing, for the reason in onFatalSignal.
    process.on('SIGINT', () => onFatalSignal('SIGINT'))
    process.on('SIGHUP', () => onFatalSignal('SIGHUP'))
    process.on('SIGTERM', () => onFatalSignal('SIGTERM'))
  }
  process.stdout.write(ENTER)
}

export function exitAltScreen(): void {
  if (depth === 0) return
  depth -= 1
  if (depth > 0) return // Inner surface done; the outer one keeps the buffer.
  process.stdout.write(LEAVE)
}

/** Test hook: forget the module-level latch. */
export function __resetAltScreenForTests(): void {
  depth = 0
  teardown = null
}
