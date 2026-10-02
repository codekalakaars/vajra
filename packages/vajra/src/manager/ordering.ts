import type { TaskQueue, TaskState } from './taskqueue.js'
import type { ReadLockMode, ScheduleOrder
} from '../bench/params.js'
import { tasksConflict } from './leases.js'

// --- choosing the next task ------------------------------------------------

/**
 * The ready tasks, in the order `scheduleOrder` asks for. The first one the
 * pool can admit is the one that starts.
 *
 * - `plan`: the order the plan lists them, which is today's behaviour.
 * - `critical-path`: the task that starts the longest chain of work still
 *   outstanding, so the chain that decides when the run ends starts first.
 * - `most-dependents`: the task holding up the most other tasks, so the run
 *   unblocks the widest set of work before it spends a Worker on a leaf.
 *
 * Ties keep plan order: the sort is stable, so an arrangement never changes
 * between two runs of the same plan on the same queue state.
 */
export function orderReadyTasks(
  queue: TaskQueue,
  order: ScheduleOrder,
  readLocks: ReadLockMode,
): TaskState[] {
  const ready = queue.getReadyTasks()
  if (order === 'plan' || ready.length < 2) return ready

  const graph = orderingGraph(queue, readLocks)
  const score = order === 'critical-path' ? heldUpLongestChain(graph) : heldUpCount(graph)
  return [...ready].sort((a, b) => score(b.id) - score(a.id))
}

/** Tasks that have not settled yet; a chain can still run through them. */
function unsettledTasks(queue: TaskQueue): TaskState[] {
  return queue
    .getAllTasks()
    .filter(task => task.status === 'pending' || task.status === 'assigned' || task.status === 'running')
}

/**
 * The edges a schedule has to respect, as `task -> tasks that cannot start
 * until it settles`: a declared dependency, or two tasks that share a file and
 * so cannot be in flight together.
 *
 * A dependency edge always points at the dependent task. A shared-file pair has
 * no declared direction, so it is chained in plan order — unless the plan
 * already puts one before the other by dependency, in which case only that
 * edge exists. That keeps the graph acyclic for a plan whose dependencies are,
 * so the scores below are a longest path rather than a walk with a cutoff.
 */
function orderingGraph(queue: TaskQueue, readLocks: ReadLockMode): Map<string, string[]> {
  const unsettled = unsettledTasks(queue)
  const byId = new Map(unsettled.map(task => [task.id, task]))
  const edges = new Map<string, string[]>(unsettled.map(task => [task.id, []]))
  const add = (from: string, to: string): void => {
    edges.get(from)?.push(to)
  }

  for (const task of unsettled) {
    for (const dep of task.dependsOn) {
      if (byId.has(dep)) add(dep, task.id)
    }
  }

  const ancestors = new Map<string, Set<string>>()
  for (const task of unsettled) {
    // Every id `dependsOn` reaches, directly or through others.
    const seen = new Set<string>()
    const stack = [...task.dependsOn]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (seen.has(id) || !byId.has(id)) continue
      seen.add(id)
      stack.push(...(byId.get(id)?.dependsOn ?? []))
    }
    ancestors.set(task.id, seen)
  }

  for (let i = 0; i < unsettled.length; i++) {
    for (let j = i + 1; j < unsettled.length; j++) {
      const earlier = unsettled[i]
      const later = unsettled[j]
      if (ancestors.get(later.id)?.has(earlier.id)) continue
      if (tasksConflict(earlier, later, readLocks)) add(earlier.id, later.id)
    }
  }

  return edges
}

/**
 * Longest chain of unsettled tasks starting at each task, itself counted: the
 * floor a schedule has to reach, so the task carrying the most of it goes first.
 */
function heldUpLongestChain(graph: Map<string, string[]>): (id: string) => number {
  const memo = new Map<string, number>()
  const walk = (id: string, visiting: Set<string>): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    // A plan whose dependencies contradict itself can still produce a loop the
    // orientation above did not remove; stop at it instead of recursing forever.
    if (visiting.has(id)) return 0
    visiting.add(id)
    let longest = 0
    for (const next of graph.get(id) ?? []) {
      longest = Math.max(longest, walk(next, visiting))
    }
    visiting.delete(id)
    const length = 1 + longest
    memo.set(id, length)
    return length
  }
  return id => walk(id, new Set())
}

/**
 * Each task's priority: how long a chain of outstanding work waits on it, so a
 * leaf nobody waits on is the lowest. Ties go to plan order — the earlier task
 * ranks higher. The scheduler pauses the lowest-priority Worker when the CPU is
 * saturated and resumes the highest first.
 */
export function taskPriorities(queue: TaskQueue, readLocks: ReadLockMode): (task: TaskState) => number {
  const chain = heldUpLongestChain(orderingGraph(queue, readLocks))
  const all = queue.getAllTasks()
  const index = new Map(all.map((task, i) => [task.id, i]))
  // The plan position is folded in below one chain step, so it only breaks ties.
  return task => chain(task.id) - (index.get(task.id) ?? all.length) / (all.length + 1)
}

/** How many unsettled tasks each task holds up, transitively. */
function heldUpCount(graph: Map<string, string[]>): (id: string) => number {
  return id => reachable(id, graph, new Set([id])).size
}

/** Every task `id` holds up, following `graph` edges once each. */
function reachable(id: string, graph: Map<string, string[]>, seen: Set<string>): Set<string> {
  for (const next of graph.get(id) ?? []) {
    if (seen.has(next)) continue
    seen.add(next)
    reachable(next, graph, seen)
  }
  return seen
}
