import {
  DIRECTORY_FILE_HASH,
  MISSING_FILE_HASH,
  UNREADABLE_FILE_HASH,
  inspectFile,
  readGitState,
  type GitState,
  type PersistedSession,
  type SessionPhase,
} from '../persist/index.js'
import { resolve } from 'node:path'
import { normalizeProjectPath } from '../tasks/permissions.js'

/**
 * What a resume must decide before it replays anything.
 *
 * The asymmetry is deliberate and is the whole point of this module:
 * rolling back to a stale baseline **destroys the user's work**, so a changed
 * file is never resolved silently in either direction.
 */
export type ResumeVerdict =
  /** Nothing changed — resume freely. */
  | { kind: 'clean' }
  /** A not-yet-run task's inputs changed: its anchors may not match any more. */
  | { kind: 'needs-replan'; reason: string; paths: string[] }
  /** The user edited completed work. Report it; never roll anything back. */
  | { kind: 'user-edited'; reason: string; paths: string[] }
  /** A task died mid-edit. Rollback is offered, never performed silently. */
  | { kind: 'rollback-offered'; reason: string; taskIds: string[] }
  /** A git branch moved under us. */
  | { kind: 'branch-changed'; reason: string; from: string; to: string }
  /** A file the session recorded has since been deleted. */
  | { kind: 'files-missing'; reason: string; paths: string[] }

export interface StalenessReport {
  verdict: ResumeVerdict
  /** project-relative path → what happened to it. */
  changed: Record<string, 'modified' | 'deleted'>
  checked: number
}

export interface StalenessOptions {
  /** Treat a pending task whose inputs changed as `needs-replan` (default true). */
  replanOnPendingChange?: boolean
  /** Consult git when both sides recorded a HEAD. Default true. */
  checkGit?: boolean
}

/**
 * Compare the tree against what the session recorded. Pure with respect to the
 * session: it reads the filesystem and git, and never writes.
 */
export function assessStaleness(
  session: PersistedSession,
  projectDir: string = session.projectDir,
  options: StalenessOptions = {},
): StalenessReport {
  const { replanOnPendingChange = true, checkGit = true } = options
  const changed: Record<string, 'modified' | 'deleted'> = {}
  const recorded = new Map<string, string>()
  for (const [path, hash] of Object.entries(session.fileHashes ?? {})) {
    recorded.set(normalizeProjectPath(projectDir, path), hash)
  }

  for (const [path, hash] of recorded) {
    const current = inspectFile(resolve(projectDir, path))
    if (current.kind === 'missing') {
      if (hash !== MISSING_FILE_HASH && hash !== UNREADABLE_FILE_HASH) changed[path] = 'deleted'
      continue
    }
    if (current.kind === 'unreadable') {
      if (hash !== UNREADABLE_FILE_HASH) changed[path] = 'modified'
      continue
    }
    if (
      hash === MISSING_FILE_HASH ||
      (hash === DIRECTORY_FILE_HASH && current.kind !== 'directory') ||
      (current.kind === 'directory' && hash !== DIRECTORY_FILE_HASH) ||
      (current.kind === 'file' && hash !== current.hash)
    ) {
      changed[path] = 'modified'
    }
  }

  const paths = Object.keys(changed)
  const report = (verdict: ResumeVerdict): StalenessReport => ({
    verdict,
    changed,
    checked: recorded.size,
  })

  if (paths.length === 0) {
    if (checkGit && session.git?.head) {
      const now = readGitState(projectDir)
      if (now && now.head !== session.git.head) {
        return report({
          kind: 'branch-changed',
          reason: `HEAD moved from ${session.git.head.slice(0, 8)} to ${now.head.slice(0, 8)}`,
          from: session.git.head,
          to: now.head,
        })
      }
    }
    return report({ kind: 'clean' })
  }

  // A recorded file that is simply gone is its own condition, and a more
  // severe one than "edited": something removed work this session produced.
  const deleted = paths.filter(p => changed[p] === 'deleted')
  if (deleted.length > 0) {
    return report({
      kind: 'files-missing',
      reason: `${deleted.length} recorded file(s) no longer exist`,
      paths: deleted.sort(),
    })
  }

  const tasks = session.tasks ?? {}
  const doneTouched: string[] = []
  const pendingTouched: string[] = []
  const runningTasks: string[] = []

  // A task's own file set: what the plan said it would touch, plus whatever
  // baselines it actually recorded.
  const plannedFiles = new Map<string, Set<string>>()
  for (const planned of session.plan?.tasks ?? []) {
    if (!planned.id) continue
    plannedFiles.set(
      planned.id,
      new Set<string>([
        ...((planned as { readFile?: string[] }).readFile ?? []),
        ...((planned as { writeFile?: string[] }).writeFile ?? []),
        ...((planned as { deleteFile?: string[] }).deleteFile ?? []),
        ...((planned as { createDir?: string[] }).createDir ?? []),
      ].map(path => normalizeProjectPath(projectDir, path))),
    )
  }

  for (const [taskId, task] of Object.entries(tasks)) {
    const own = new Set<string>([
      ...(plannedFiles.get(taskId) ?? []),
      ...Object.keys(task.baselines ?? {}),
    ])
    const hit = paths.filter(p => own.has(p))
    if (hit.length === 0) continue
    if (task.status === 'running' || task.status === 'assigned') runningTasks.push(taskId)
    else if (task.status === 'pending') pendingTouched.push(...hit)
    else if (task.status === 'done' || task.status === 'skipped') doneTouched.push(...hit)
  }

  // A task that died mid-edit is the only case where we may offer to undo
  // anything — and even then it is the user's decision, not ours.
  if (runningTasks.length > 0) {
    return report({
      kind: 'rollback-offered',
      reason: `${runningTasks.length} task(s) were interrupted mid-edit`,
      taskIds: runningTasks,
    })
  }

  // The user edited finished work. Say so and continue; never roll back.
  if (doneTouched.length > 0) {
    return report({
      kind: 'user-edited',
      reason: `${doneTouched.length} file(s) changed since a task completed`,
      paths: [...new Set(doneTouched)].sort(),
    })
  }

  if (replanOnPendingChange && pendingTouched.length > 0) {
    return report({
      kind: 'needs-replan',
      reason: `${new Set(pendingTouched).size} input file(s) for pending tasks changed`,
      paths: [...new Set(pendingTouched)].sort(),
    })
  }

  return report({ kind: 'clean' })
}

/** One-line human summary, used by the CLI and the TUI alike. */
export function describeVerdict(report: StalenessReport): string {
  switch (report.verdict.kind) {
    case 'clean':
      return 'No files changed since this session was saved.'
    case 'needs-replan':
      return `${report.verdict.reason}. Re-planning may be needed: ${report.verdict.paths.join(', ')}`
    case 'user-edited':
      return `${report.verdict.reason}. Continuing — completed work is never rolled back.`
    case 'rollback-offered':
      return `${report.verdict.reason} (${report.verdict.taskIds.join(', ')}).`
    case 'branch-changed':
      return `${report.verdict.reason}.`
    case 'files-missing':
      return `${report.verdict.reason}: ${report.verdict.paths.join(', ')}`
  }
}

/** A verdict that must stop an automatic resume and demand a human choice. */
export function blocksAutomaticResume(verdict: ResumeVerdict): boolean {
  return verdict.kind !== 'clean'
}

export interface ResumePlan {
  session: PersistedSession
  phase: SessionPhase
  /** Task ids that still need to run. */
  pending: string[]
  /** Task ids that finished, in recorded order. */
  completed: string[]
  /** Restore the conversation so the Developer keeps its context. */
  restoreMessages: boolean
  /** Re-present the plan for approval. */
  reapprove: boolean
  /** Never set without an explicit user decision. */
  rollbackTaskIds: string[]
  staleness: StalenessReport
}

export interface ResumePlanOptions {
  projectDir?: string
  /** The user explicitly accepted a rollback of these interrupted tasks. */
  rollbackTaskIds?: string[]
  /** Skip the staleness gate entirely (tests, trusted trees). */
  assumeFresh?: boolean
}

/**
 * Turn a persisted session into a decision. This never touches the working
 * tree — it only says what *would* happen.
 */
export function planResume(
  session: PersistedSession,
  options: ResumePlanOptions = {},
): ResumePlan {
  const projectDir = options.projectDir ?? session.projectDir
  const staleness = options.assumeFresh
    ? ({ verdict: { kind: 'clean' as const }, changed: {}, checked: 0 })
    : assessStaleness(session, projectDir)

  const tasks = Object.entries(session.tasks ?? {})
  const completed = tasks
    .filter(([, t]) => t.status === 'done' || t.status === 'skipped')
    .map(([id]) => id)
  // `needs-replan` means the plan itself is suspect: re-run nothing blindly,
  // hand it back to the Developer instead.
  const pending =
    staleness.verdict.kind === 'needs-replan'
      ? []
      : tasks
          .filter(([, t]) => t.status === 'pending')
          .map(([id]) => id)

  const explicitRollback = new Set(options.rollbackTaskIds ?? [])
  const rollbackTaskIds =
    staleness.verdict.kind === 'rollback-offered'
      ? [...explicitRollback].filter(id => staleness.verdict.kind === 'rollback-offered' &&
          staleness.verdict.taskIds.includes(id))
      : []

  const phase: SessionPhase =
    staleness.verdict.kind === 'needs-replan'
      ? 'conversing'
      : session.phase

  return {
    session,
    phase,
    pending,
    completed,
    restoreMessages: true,
    reapprove: phase === 'awaiting-approval',
    rollbackTaskIds,
    staleness,
  }
}

export type { GitState }
