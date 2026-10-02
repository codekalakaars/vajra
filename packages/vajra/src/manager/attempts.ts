import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChangeHistory } from '@codekalakaars/vajra-sandbox'
import { diffsWithin, type DiffFile } from '../worker/diff.js'
import type { AttemptRecord, Handoff } from '../worker/context-types.js'
import { buildHandoff } from './handoff.js'
import type { TaskQueue, TaskState } from './taskqueue.js'

/**
 * What each completed task published, and what each failed attempt left.
 *
 * Both are in memory and in the run's result, not in a store: a tuning run must
 * not leave ten records per suite, and a handoff is only meaningful for the run
 * it belongs to, because the files it names are changed again by the next run.
 */
export interface AttemptLog {
  /** The attempts already made at a task, oldest first. */
  previous(taskId: string): AttemptRecord[]
  /** The handoffs a task starts from: direct dependencies in full, the rest as interfaces only. */
  upstreamOf(task: TaskState): { direct: Handoff[]; transitive: Handoff[] } | undefined
  /**
   * Record an attempt that has just ended, and publish its handoff if it succeeded.
   *
   * Must run before the rollback that follows a failed attempt: the rollback
   * deletes the evidence the diff is made from.
   */
  record(
    task: TaskState,
    success: boolean,
    end: Omit<AttemptRecord, 'attempt' | 'diff'> | undefined,
  ): void
}

export function createAttemptLog(env: {
  queue: TaskQueue
  changeHistory: ChangeHistory
  projectDir: string
  respawnDiffChars: number
  handoffSummaryChars: number
}): AttemptLog {
  const { queue, changeHistory, projectDir } = env
  const handoffs = new Map<string, Handoff>()
  const attempts = new Map<string, AttemptRecord[]>()

  /**
   * The before and after of every file an attempt is on record for changing.
   *
   * `undefined` from the ledger means no baseline was recorded, and there is no
   * honest diff to write for that file.
   */
  const attemptContent = (
    task: TaskState,
  ): { files: string[]; before: Map<string, string | null>; after: Map<string, string | null> } => {
    const files = changeHistory.getTaskFiles(task.id)
    const before = new Map<string, string | null>()
    const after = new Map<string, string | null>()
    for (const path of files) {
      const original = changeHistory.getOriginalContent(task.id, path)
      if (original === undefined) continue
      before.set(path, original)
      try {
        after.set(path, readFileSync(resolve(projectDir, path), 'utf-8'))
      } catch {
        after.set(path, null)
      }
    }
    return { files: [...before.keys()], before, after }
  }

  const diffOfAttempt = (task: TaskState): string => {
    const { files, before, after } = attemptContent(task)
    return diffsWithin(
      files.map((path): DiffFile => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null })),
      env.respawnDiffChars,
    )
  }

  return {
    previous: taskId => attempts.get(taskId) ?? [],

    // Split direct and transitive because a transitive handoff describes code
    // written against a tree this task is not looking at, while the declarations
    // it established are exactly what a caller two steps away needs.
    upstreamOf: task => {
      const direct: Handoff[] = []
      for (const id of task.dependsOn) {
        const handoff = handoffs.get(id)
        if (handoff) direct.push(handoff)
      }
      const transitive: Handoff[] = []
      const seen = new Set(task.dependsOn)
      const frontier = [...task.dependsOn]
      while (frontier.length > 0) {
        const id = frontier.shift() as string
        for (const depId of queue.getTask(id)?.dependsOn ?? []) {
          if (seen.has(depId)) continue
          seen.add(depId)
          const handoff = handoffs.get(depId)
          if (handoff) transitive.push(handoff)
          frontier.push(depId)
        }
      }
      return direct.length === 0 && transitive.length === 0 ? undefined : { direct, transitive }
    },

    record: (task, success, end) => {
      const earlier = attempts.get(task.id) ?? []
      const recorded: AttemptRecord = {
        attempt: earlier.length + 1,
        ...(end ?? { outcome: success ? 'done' : 'error', filesWritten: [] }),
        ...(success ? {} : { diff: diffOfAttempt(task) }),
      }
      attempts.set(task.id, [...earlier, recorded])
      if (success && end) {
        const { before, after } = attemptContent(task)
        handoffs.set(
          task.id,
          buildHandoff({
            taskId: task.id,
            title: task.title,
            filesWritten: end.filesWritten,
            before,
            after,
            summary: end.summary ?? '',
            maxSummaryChars: env.handoffSummaryChars,
          }),
        )
      }
    },
  }
}
