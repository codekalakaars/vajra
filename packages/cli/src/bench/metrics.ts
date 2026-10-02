import { leaseKey } from '../agent/leases.js'
import { getModelLimit } from '../agent/context-window.js'
import type { AgentEvent, TaskEvent } from '../session/ui.js'
import type { ReadLockMode, WorkerParams } from './params.js'
import type { BenchResult, BenchTaskResult } from './result.js'

/**
 * What one bench run measured, read off the two event streams the runtime
 * already emits. Nothing here watches a task directly: `TaskEvent` and
 * `AgentEvent` are the same events the CLI renderer prints, so a measurement
 * cannot drift away from the run it describes.
 *
 * Three numbers decide what to tune next:
 *
 *  - `wallMs` is the score: the first Worker spawned to the last task completed.
 *  - `criticalPathMs` is the floor. It is the longest chain of tasks that
 *    cannot overlap — each link is either a dependency or a path both tasks
 *    take, which locks them into sequence. No arrangement of Workers makes the
 *    run shorter than this, so a `wallMs` near it means the scheduler is done
 *    and only per-Worker speed can still help.
 *  - `idleMs` is the mirror image: time a task could have been running — its
 *    dependencies settled and no other task holding a file it needs — but was
 *    not, because no slot was free. It is what a better arrangement can take
 *    back. Waiting on a file another task holds is not counted: under the run's
 *    lock mode no arrangement could have overlapped the two.
 *
 * Timing comes from a clock the recorder owns (`now`, epoch ms), because the
 * events themselves carry no timestamps — that is what makes a run measurable
 * and what lets the tests drive a synthetic one.
 */

/**
 * The plan, as far as measurement is concerned.
 *
 * A protocol `PlannedTask` and a `TaskState` both satisfy it structurally, so
 * callers pass whichever they already hold rather than restating the plan.
 */
export interface BenchTaskSpec {
  id: string
  title: string
  dependsOn?: readonly string[]
  readFile?: readonly string[]
  writeFile?: readonly string[]
  deleteFile?: readonly string[]
  createDir?: readonly string[]
}

export interface BenchRecorderSpec {
  /** The suite this run is measuring, as `bench <suite>` named it. */
  suite: string
  /** The full config the run used, echoed into the result so a score says what produced it. */
  config: WorkerParams
  tasks: readonly BenchTaskSpec[]
  /** Injected by the tests. Defaults to `Date.now`. */
  now?: () => number
}

/** The run's outcome, which only the caller knows: the acceptance command runs after the last event. */
export interface BenchOutcome {
  success: boolean
  failureReason?: string
}

export interface BenchRecorder {
  /** Feed every `TaskEvent` the run emits. */
  taskEvent(event: TaskEvent): void
  /** Feed every `AgentEvent` the run emits. */
  agentEvent(event: AgentEvent): void
  /** The measurement, once the run and its acceptance command are over. */
  result(outcome: BenchOutcome): BenchResult
}

type TaskStatus = BenchTaskResult['status']

interface TaskRecord {
  id: string
  title: string
  /** Position in the plan; the tiebreak when two tasks have the same start time. */
  index: number
  deps: string[]
  /** Every path the task takes a lock on, and the ones it may write. */
  paths: Set<string>
  writePaths: Set<string>
  status: TaskStatus
  readyAt?: number
  startedAt?: number
  endedAt?: number
  attempts: number
  modelRounds: number
  toolCalls: number
  /** The largest prompt one model round sent, as the provider counted it. */
  peakPromptTokens: number
  /** How many times the Worker's history was trimmed to fit its window. */
  contextTrims: number
  /** Time the scheduler held this task's Worker paused, and when the current pause began. */
  pausedMs: number
  pausedSince?: number
  /** An attempt is open from the event that opened it to the task's terminal event. */
  attemptOpen: boolean

  // --- context management (K5) --------------------------------------------
  /** What the pack this Worker started from was worth, and what it carried. */
  packTokens: number
  packHash?: string
  packSectionsCut: number
  packPaths: Set<string>
  staleAnchors: number
  relocatedAnchors: number
  /** Reads, searches and listings of a path the pack did not carry. */
  seeks: number
  /** Reads of a pack path made before the Worker changed it. */
  redundantReads: number
  /** Model rounds before the first write, once one has happened. */
  roundsToFirstEdit?: number
  elisions: number
  compactions: number
  stuck: number
  /** Paths changed by this task, as the recorder saw the Worker change them. */
  mutated: Set<string>
}

/** The tools that change a file: what "rounds to first edit" is measured from. */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'create_dir'])

/** Stands in for "later than any recorded time", so a never-run task sorts last. */
const NEVER = Number.MAX_SAFE_INTEGER

function toRecord(spec: BenchTaskSpec, index: number): TaskRecord {
  // Spelled the way the lock manager compares them, so two spellings of one
  // file are one file here too.
  const key = (paths: readonly string[] | undefined): string[] => (paths ?? []).map(path => leaseKey(path))
  const writePaths = new Set([
    ...key(spec.writeFile),
    ...key(spec.deleteFile),
    ...key(spec.createDir),
  ])
  return {
    id: spec.id,
    title: spec.title,
    index,
    deps: [...(spec.dependsOn ?? [])],
    paths: new Set([...key(spec.readFile), ...writePaths]),
    writePaths,
    status: 'pending',
    attempts: 0,
    modelRounds: 0,
    toolCalls: 0,
    peakPromptTokens: 0,
    contextTrims: 0,
    pausedMs: 0,
    attemptOpen: false,
    packTokens: 0,
    packSectionsCut: 0,
    packPaths: new Set(),
    staleAnchors: 0,
    relocatedAnchors: 0,
    seeks: 0,
    redundantReads: 0,
    elisions: 0,
    compactions: 0,
    stuck: 0,
    mutated: new Set(),
  }
}

export function createBenchRecorder(spec: BenchRecorderSpec): BenchRecorder {
  const now = spec.now ?? Date.now
  const records = spec.tasks.map(toRecord)
  /** Every path read outside a pack, and how often, across the whole run. */
  const missed = new Map<string, number>()

  // Both event streams carry the task's id, so two tasks with one title are
  // still two records.
  const byId = new Map<string, TaskRecord>()
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, record)
  }

  /** The score's zero: the first moment a Worker was running. */
  let firstAt: number | undefined
  /** The last thing the run said, so an attempt still in flight can be closed off. */
  let lastAt: number | undefined

  const resolve = (event: TaskEvent | AgentEvent): TaskRecord | undefined => {
    if ('agent' in event) {
      // Only Workers are measured: a Developer, or a resumed session's replayed
      // turns, would otherwise land on whichever task shares a title.
      if (event.agent.role !== 'worker' || !event.agent.taskId) return undefined
      return byId.get(event.agent.taskId)
    }
    return byId.get(event.taskId)
  }

  const markFirst = (at: number): void => {
    if (firstAt === undefined || at < firstAt) firstAt = at
  }

  const openAttempt = (record: TaskRecord, at: number): void => {
    if (!record.attemptOpen) {
      record.attemptOpen = true
      record.attempts++
      // The first attempt sets the task's start; a retry does not move it, so
      // the task's measured duration covers the retries and the rollback
      // between them — the span a dependency's successor really waits through.
      record.startedAt ??= at
      record.endedAt = undefined
    }
    markFirst(at)
  }

  // The share of the Worker model's window a prompt took. Read once: the
  // window is the model's, and every Worker in a run uses the same model.
  const window = getModelLimit(spec.config.workerModel)
  const contextShare = (tokens: number): number =>
    window > 0 ? Math.round((tokens / window) * 1000) / 1000 : 0

  const endPause = (record: TaskRecord, at: number): void => {
    if (record.pausedSince === undefined) return
    record.pausedMs += Math.max(0, at - record.pausedSince)
    record.pausedSince = undefined
  }

  /**
   * Whether a path the Worker named is one the pack already carried.
   *
   * A directory counts as covered when the pack holds anything inside it: listing
   * `src` when the pack shows three files under `src` is the Worker orienting
   * itself in what it was given, not reaching for something it did not have.
   */
  const carried = (record: TaskRecord, path: string): boolean => {
    const wanted = path.replace(/\/+$/, '')
    for (const carriedPath of record.packPaths) {
      if (carriedPath === wanted) return true
      if (carriedPath.startsWith(`${wanted}/`)) return true
    }
    return false
  }

  /** One miss, recorded against the task and against the run. */
  const miss = (path: string): void => {
    missed.set(path, (missed.get(path) ?? 0) + 1)
  }

  const onTaskEvent = (event: TaskEvent): void => {
    const at = now()
    lastAt = at
    const record = resolve(event)
    if (!record) return

    switch (event.type) {
      case 'start':
        // A `start` per attempt, so it opens one even when the previous attempt
        // failed without a terminal event — the Manager's `retry` sits between.
        record.attemptOpen = false
        openAttempt(record, at)
        break
      case 'done':
      case 'failed':
      case 'skipped':
        endPause(record, at)
        record.status = event.type
        record.endedAt = at
        record.attemptOpen = false
        break
      case 'retry':
      case 'no-changes':
        // Nothing to time: the next `start` is the moment that counts.
        break
    }
  }

  const onAgentEvent = (event: AgentEvent): void => {
    const at = now()
    lastAt = at
    const record = resolve(event)
    if (!record) return
    openAttempt(record, at)
    if (event.type === 'llm-start') record.modelRounds++
    else if (event.type === 'tool-start') record.toolCalls++
    else if (event.type === 'llm-end' && event.usage) {
      record.peakPromptTokens = Math.max(record.peakPromptTokens, event.usage.promptTokens)
    } else if (event.type === 'warning' && event.text.startsWith('Context trimmed')) {
      record.contextTrims++
    }
    else if (event.type === 'phase') {
      // A pause is announced as a phase, and ends at the next phase the Worker
      // reports — the one it is resumed into.
      if (event.phase === 'paused') record.pausedSince ??= at
      else endPause(record, at)
    } else if (event.type === 'context') {
      if (event.kind === 'pack' && event.pack) {
        record.packTokens = event.pack.tokens
        record.packHash = event.pack.hash
        record.packSectionsCut = event.pack.omitted
        record.staleAnchors = event.pack.stale
        record.relocatedAnchors = event.pack.relocated
        for (const path of event.pack.paths) record.packPaths.add(path)
        return
      }
      if (event.kind === 'elided') record.elisions++
      else if (event.kind === 'compacted') record.compactions++
      else if (event.kind === 'stuck') record.stuck++
      return
    }

    if (event.type !== 'tool-start') return
    const summary = event.summary.trim()
    if (summary === '') return

    if (MUTATING_TOOLS.has(event.tool)) {
      if (record.roundsToFirstEdit === undefined) record.roundsToFirstEdit = record.modelRounds
      record.mutated.add(summary)
      return
    }

    /**
     * A search names no single path: it is a reach for something the pack did not
     * hand over, and counting it is the honest answer rather than dropping it from
     * the ratio, which would make a pack that is missing everything look perfect.
     */
    if (event.tool === 'search_content' || event.tool === 'search_files') {
      record.seeks++
      miss('(search)')
      return
    }
    if (event.tool !== 'read_file' && event.tool !== 'list_files') return
    if (carried(record, summary)) {
      // Reading what the pack already showed, before anything changed it, is a
      // round the pack did not save. After a change it is the Worker keeping its
      // own copy honest, which is not waste.
      if (event.tool === 'read_file' && !record.mutated.has(summary)) record.redundantReads++
      return
    }
    record.seeks++
    miss(summary)
  }

  /**
   * When a task could first have started: its last dependency settled, and the
   * last task that held one of its files under the run's lock mode let go.
   *
   * Computed from the plan and the measured times rather than from an event. A
   * task with no dependencies and no file to wait for is ready the moment the
   * run starts scheduling. `undefined` means it never became ready — an unknown
   * or failed dependency leaves it pending, or skipped, and time it spent
   * waiting was not the arrangement's to lose.
   */
  const readyAt = (record: TaskRecord): number | undefined => {
    let latest = firstAt
    for (const depId of record.deps) {
      const dep = byId.get(depId)
      if (!dep) return undefined
      if (dep.status !== 'done' && dep.status !== 'skipped') return undefined
      if (dep.endedAt === undefined) return undefined
      latest = latest === undefined ? dep.endedAt : Math.max(latest, dep.endedAt)
    }
    if (record.startedAt === undefined) return latest
    // A task that held a file this one needs, and finished before this one
    // started, kept it waiting however many slots were free.
    for (const other of records) {
      if (other === record || other.startedAt === undefined || other.endedAt === undefined) continue
      if (other.startedAt >= record.startedAt || other.endedAt > record.startedAt) continue
      if (!sharesConflict(record, other, spec.config.readLocks)) continue
      latest = latest === undefined ? other.endedAt : Math.max(latest, other.endedAt)
    }
    return latest
  }

  return {
    taskEvent: onTaskEvent,
    agentEvent: onAgentEvent,
    result(outcome: BenchOutcome): BenchResult {
      // Resolve every ready time first: the idle sum and the same-file ordering
      // both need them, and neither may depend on iteration order.
      let idleMs = 0
      for (const record of records) {
        const ready = readyAt(record)
        if (ready === undefined) {
          // It ran without a readable dependency order — a resumed run, or a
          // stream that lost an event. Zero idle is the honest answer: there is
          // no measured wait to report.
          record.readyAt = record.startedAt
          continue
        }
        record.readyAt = ready
        if (record.startedAt !== undefined) {
          idleMs += Math.max(0, record.startedAt - ready)
        }
      }

      // "Last task completed", not "last event seen": a task still in flight
      // when the run stopped was never completed, and a failed run has no score.
      const lastEnd = records.reduce<number | undefined>(
        (latest, record) =>
          record.endedAt === undefined
            ? latest
            : latest === undefined
              ? record.endedAt
              : Math.max(latest, record.endedAt),
        undefined,
      )

      // A seek is a share of the looking-for, so the run's ratio is over every
      // tool call rather than an average of per-task ratios: a task with four
      // calls and four misses should not weigh the same as one with forty.
      const toolCalls = records.reduce((sum, record) => sum + record.toolCalls, 0)
      const seeks = records.reduce((sum, record) => sum + record.seeks, 0)
      const ratio = (numerator: number, denominator: number): number =>
        denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : 0
      const mostMissedPaths = [...missed.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))
        .slice(0, 20)

      return {
        suite: spec.suite,
        config: { ...spec.config },
        success: outcome.success,
        ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
        wallMs: firstAt === undefined || lastEnd === undefined ? 0 : Math.max(0, lastEnd - firstAt),
        criticalPathMs: longestChainMs(records, spec.config.readLocks, lastAt ?? NEVER),
        idleMs,
        pausedMs: records.reduce((sum, record) => sum + record.pausedMs, 0),
        peakContextShare: Math.max(0, ...records.map(record => contextShare(record.peakPromptTokens))),
        contextTrims: records.reduce((sum, record) => sum + record.contextTrims, 0),
        seekRatio: ratio(seeks, toolCalls),
        packTokens: records.reduce((sum, record) => sum + record.packTokens, 0),
        packSectionsCut: records.reduce((sum, record) => sum + record.packSectionsCut, 0),
        elisions: records.reduce((sum, record) => sum + record.elisions, 0),
        compactions: records.reduce((sum, record) => sum + record.compactions, 0),
        stuck: records.reduce((sum, record) => sum + record.stuck, 0),
        mostMissedPaths,
        tasks: records.map(record => ({
          id: record.id,
          title: record.title,
          ...(record.readyAt === undefined ? {} : { readyAt: record.readyAt }),
          ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
          ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
          status: record.status,
          attempts: record.attempts,
          modelRounds: record.modelRounds,
          toolCalls: record.toolCalls,
          pausedMs: record.pausedMs,
          peakPromptTokens: record.peakPromptTokens,
          peakContextShare: contextShare(record.peakPromptTokens),
          contextTrims: record.contextTrims,
          packTokens: record.packTokens,
          ...(record.packHash === undefined ? {} : { packHash: record.packHash }),
          packSectionsCut: record.packSectionsCut,
          packPaths: [...record.packPaths].sort(),
          staleAnchors: record.staleAnchors,
          relocatedAnchors: record.relocatedAnchors,
          seeks: record.seeks,
          seekRatio: ratio(record.seeks, record.toolCalls),
          redundantReads: record.redundantReads,
          roundsToFirstEdit: record.roundsToFirstEdit ?? null,
          elisions: record.elisions,
          compactions: record.compactions,
          stuck: record.stuck,
        })),
      }
    },
  }
}

/**
 * The longest chain of tasks that cannot overlap, weighted by what each task
 * actually took.
 *
 * Two kinds of link. A dependency link is a fact about the plan. A file link is
 * a fact about the run: two tasks cannot be in flight together when both take
 * the same path, which under `exclusive` read locks is every shared path, and
 * under `shared` is only a path at least one of them writes. Both links are
 * oriented the way the run ordered the pair, so the graph is acyclic by
 * construction and every path through it is a sequence the run was obliged to
 * execute in that order.
 *
 * A task still in flight when the run stopped is charged to `fallbackEnd`, the
 * last thing the run said: its duration is a lower bound, and a lower bound is
 * what a floor has to be.
 */
function longestChainMs(
  records: readonly TaskRecord[],
  readLocks: ReadLockMode,
  fallbackEnd: number,
): number {
  const byId = new Map(records.map(record => [record.id, record]))
  const successors = new Map<string, string[]>()
  const link = (from: TaskRecord, to: TaskRecord): void => {
    if (from.id === to.id) return
    const edges = successors.get(from.id) ?? []
    if (!edges.includes(to.id)) edges.push(to.id)
    successors.set(from.id, edges)
  }

  for (const record of records) {
    for (const depId of record.deps) {
      const dep = byId.get(depId)
      if (dep) link(dep, record)
    }
  }

  const byPath = new Map<string, TaskRecord[]>()
  for (const record of records) {
    for (const path of record.paths) {
      const group = byPath.get(path) ?? []
      group.push(record)
      byPath.set(path, group)
    }
  }
  for (const group of byPath.values()) {
    const ordered = [...group].sort(byRunOrder)
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        if (conflicts(ordered[i], ordered[j], readLocks)) link(ordered[i], ordered[j])
      }
    }
  }

  const duration = (record: TaskRecord): number => {
    if (record.startedAt === undefined) return 0
    return Math.max(0, (record.endedAt ?? fallbackEnd) - record.startedAt)
  }

  // Memoised DFS. `visiting` is not for a well-formed plan — both kinds of link
  // point forward — but a plan with a dependency cycle in it must not hang the
  // run that is trying to measure it, so a back edge contributes nothing.
  const best = new Map<string, number>()
  const visiting = new Set<string>()
  const chainFrom = (record: TaskRecord): number => {
    const cached = best.get(record.id)
    if (cached !== undefined) return cached
    if (visiting.has(record.id)) return 0
    visiting.add(record.id)
    let tail = 0
    for (const nextId of successors.get(record.id) ?? []) {
      const next = byId.get(nextId)
      if (next) tail = Math.max(tail, chainFrom(next))
    }
    visiting.delete(record.id)
    const total = duration(record) + tail
    best.set(record.id, total)
    return total
  }

  let longest = 0
  for (const record of records) longest = Math.max(longest, chainFrom(record))
  return longest
}

/** Which of two tasks started first; a task that never started sorts last. */
function byRunOrder(a: TaskRecord, b: TaskRecord): number {
  const startA = a.startedAt ?? a.readyAt ?? NEVER
  const startB = b.startedAt ?? b.readyAt ?? NEVER
  if (startA !== startB) return startA < startB ? -1 : 1
  return a.index - b.index
}

/**
 * Whether two tasks can be in flight at once over a path they share.
 *
 * `exclusive` locks every path for writing, read files included, so any shared
 * path serialises the pair. `shared` gives a read file a read lease, so only a
 * path at least one of the two writes still serialises them.
 */
function conflicts(a: TaskRecord, b: TaskRecord, readLocks: ReadLockMode): boolean {
  if (readLocks === 'exclusive') return true
  for (const path of a.writePaths) {
    if (b.paths.has(path)) return true
  }
  for (const path of b.writePaths) {
    if (a.paths.has(path)) return true
  }
  return false
}

/** Whether the two tasks share a path that keeps them from overlapping. */
function sharesConflict(a: TaskRecord, b: TaskRecord, readLocks: ReadLockMode): boolean {
  for (const path of a.paths) {
    if (b.paths.has(path)) return conflicts(a, b, readLocks)
  }
  return false
}
