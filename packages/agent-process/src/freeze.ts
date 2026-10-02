import { readdirSync, readFileSync } from 'node:fs'

/**
 * Freezing and thawing a worker together with everything it started.
 *
 * Stopping the worker alone is not enough. Every command it runs is put in a
 * process group of its own (`setpgid` in core's process.rs, so a timeout can
 * kill the whole command), which means a signal to the worker's group never
 * reaches a test run or a build — and those are where a Worker's CPU goes. So
 * the tree is found by walking `/proc` for parent links, and each process in it
 * is signalled directly.
 *
 * Stopped top-down: the worker first, so it cannot start a command while its
 * children are being found. A command can still fork in the moment between the
 * walk and its own stop, so the walk repeats until it finds nothing new.
 */

/** Every live process's parent, from `/proc/<pid>/stat`. */
function parentLinks(): Map<number, number[]> {
  const children = new Map<number, number[]>()
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return children
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf-8')
    } catch {
      continue // exited between the listing and the read
    }
    // The command name is in parentheses and may itself contain spaces or
    // parentheses, so the fields are counted from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(fields[1])
    if (!Number.isInteger(ppid)) continue
    const list = children.get(ppid) ?? []
    list.push(Number(entry))
    children.set(ppid, list)
  }
  return children
}

/** Every descendant of `root`, not including it. */
export function descendants(root: number): number[] {
  const children = parentLinks()
  const found: number[] = []
  const queue = [...(children.get(root) ?? [])]
  const seen = new Set<number>([root])
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    found.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return found
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone: nothing to stop or continue.
  }
}

/** Stop `root` and every process under it. */
export function freezeTree(root: number): void {
  signal(root, 'SIGSTOP')
  const stopped = new Set<number>()
  for (let pass = 0; pass < 5; pass++) {
    const fresh = descendants(root).filter(pid => !stopped.has(pid))
    if (fresh.length === 0) return
    for (const pid of fresh) {
      signal(pid, 'SIGSTOP')
      stopped.add(pid)
    }
  }
}

/** Continue every process under `root`, then `root` itself. */
export function thawTree(root: number): void {
  for (const pid of descendants(root)) signal(pid, 'SIGCONT')
  signal(root, 'SIGCONT')
}
