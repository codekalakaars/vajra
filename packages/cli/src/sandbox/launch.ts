// Parent side of the CLI sandboxed worker (Group Q).
//
// Forks dist/sandbox/worker.js, sends a buildLaunchJob() payload, waits for
// the sandbox-report, and exposes tool calls as a LaunchHandle over IPC.
// The parent never calls applySandbox itself.

import { fork, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaunchHandle } from '../agent/developer.js'
import {
  buildLaunchJob,
  createSandboxConfig,
  loadSandboxConfig,
  type LaunchJob,
  type SandboxConfig,
} from '@codekalakaars/vajra-sandbox'
import { normalizeProjectPath, type TaskFilePermissions } from '../tasks/permissions.js'

export interface SandboxReport {
  enforced: boolean
  mechanism: string
  warnings: string[]
}

export interface SandboxSession {
  handle: LaunchHandle
  report: SandboxReport
  /** Swap app-level task file permissions for the session handle. */
  setTaskPermissions: (lookup: (path: string) => TaskFilePermissions | null) => void
  /** Parent-side dirty hook for the session handle: fired after a successful mutating tool. */
  setOnMutate: (fn: () => void) => void
  /**
   * Register per-task permission lookup and dirty hook, returning a handle
   * whose tool calls consult that task's state only (P1).
   */
  handleForTask(
    taskId: string,
    lookup: (path: string) => TaskFilePermissions | null,
    onMutate: () => void,
  ): LaunchHandle
  /** Drop a task's scoped permission lookup and dirty hook. */
  releaseTask: (taskId: string) => void
  close: () => void
}

export interface LaunchSandboxOptions {
  /** Prefer an existing .vajra-sandbox.json when present. */
  allowUnenforced?: boolean
  /** Fail instead of returning a session when the platform cannot enforce. */
  requireEnforced?: boolean
  timeoutMs?: number
}

const WORKER_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'NODE_ENV',
] as const

function buildWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function resolveWorkerPath(): string {
  return fileURLToPath(new URL('./worker.js', import.meta.url))
}

/**
 * The worker must be able to re-exec the Node interpreter under Landlock.
 * nvm/asdf/homebrew installs live outside the hardcoded /usr //bin grants, so
 * always merge process.execPath (and its bin dir for PATH lookup) into the
 * read+execute set — otherwise run_command dies with EACCES on `node`.
 */
function withNodeToolchain(paths: readonly string[]): string[] {
  const nodeBin = process.execPath
  const nodeBinDir = dirname(nodeBin)
  const merged = new Set(paths)
  merged.add(nodeBin)
  merged.add(nodeBinDir)
  return [...merged]
}

function resolveSandboxConfig(projectDir: string, allowUnenforced: boolean): SandboxConfig {
  const loaded = loadSandboxConfig(projectDir)
  if (loaded) {
    // CLI UX: never hard-fail on Windows when the user has no opinion set.
    if (allowUnenforced && loaded.allowUnenforced === false && loaded.fileRules.length === 0) {
      return createSandboxConfig({
        projectDir,
        allowUnenforced: true,
        fileRules: [...loaded.fileRules],
        defaultPermissions: { ...loaded.defaultPermissions },
        allowedTools: loaded.allowedTools ? [...loaded.allowedTools] : undefined,
        readExecutePaths: withNodeToolchain(loaded.readExecutePaths),
        readWritePaths: [...loaded.readWritePaths],
      })
    }
    return createSandboxConfig({
      projectDir,
      allowUnenforced: loaded.allowUnenforced,
      fileRules: [...loaded.fileRules],
      defaultPermissions: { ...loaded.defaultPermissions },
      allowedTools: loaded.allowedTools ? [...loaded.allowedTools] : undefined,
      readExecutePaths: withNodeToolchain(loaded.readExecutePaths),
      readWritePaths: [...loaded.readWritePaths],
    })
  }
  // No project config: grant full in-project access. The OS sandbox confines
  // the worker; app-level task permissions (parent) gate which paths each task
  // may touch. write:false here would make every write_file fail.
  return createSandboxConfig({
    projectDir,
    allowUnenforced,
    defaultPermissions: { read: true, write: true, edit: true, delete: true },
    readExecutePaths: withNodeToolchain([]),
  })
}

/**
 * App-level permission gate applied in the parent before a call is forwarded.
 * With no lookup for the scope the call is unrestricted; with a lookup, paths
 * it does not know about are denied.
 */
function assertToolPermission(
  lookup: ((path: string) => TaskFilePermissions | null) | undefined,
  tool: string,
  args: unknown,
): void {
  if (!lookup) return
  if (tool === 'list_files' || tool === 'search_files') return
  const a = (args ?? {}) as { path?: unknown }
  if (typeof a.path !== 'string') return
  const perm = lookup(a.path)
  const op =
    tool === 'read_file'
      ? 'read'
      : tool === 'write_file' || tool === 'create_dir'
        ? 'write'
        : tool === 'edit_file'
          ? 'edit'
          : tool === 'delete_file'
            ? 'delete'
            : null
  if (op && perm && !perm[op]) {
    throw new Error(`Access denied: ${a.path}`)
  }
  if (op && !perm) {
    throw new Error(`Access denied: ${a.path}`)
  }
}

/**
 * Fork the sandboxed worker and return a LaunchHandle that proxies tool calls
 * over IPC. Throws if the worker refuses to start or applySandbox fails.
 */
export async function launchSandboxSession(
  projectDir: string,
  sessionId: string,
  options: LaunchSandboxOptions = {},
): Promise<SandboxSession> {
  const allowUnenforced = options.allowUnenforced ?? false
  const requireEnforced = options.requireEnforced ?? !allowUnenforced
  const timeoutMs = options.timeoutMs ?? 15_000
  const config = resolveSandboxConfig(projectDir, allowUnenforced)
  const job: LaunchJob = buildLaunchJob(config, sessionId)

  const child: ChildProcess = fork(resolveWorkerPath(), [], {
    cwd: projectDir,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: buildWorkerEnv(),
  })

  // Session-wide state for the shared handle lives under a reserved scope key
  // so setTaskPermissions/setOnMutate cannot collide with a real task id.
  const SESSION_SCOPE = '__session'
  const taskLookups = new Map<string, (path: string) => TaskFilePermissions | null>()
  const taskOnMutate = new Map<string, () => void>()

  let nextCallId = 1
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; scope: string }
  >()

  const reportPromise = new Promise<SandboxReport>((resolveReport, rejectReport) => {
    const timer = setTimeout(() => {
      rejectReport(new Error(`Sandbox worker did not report within ${timeoutMs}ms`))
    }, timeoutMs)

    const onMessage = (message: {
      type?: string
      report?: SandboxReport
      message?: string
      callId?: string
      ok?: boolean
      result?: unknown
      error?: string
      mutated?: boolean
    }) => {
      if (!message) return

      if (message.type === 'sandbox-report' && message.report) {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.on('message', onRuntimeMessage)
        resolveReport(message.report)
        return
      }

      if (message.type === 'refused') {
        clearTimeout(timer)
        child.off('message', onMessage)
        rejectReport(new Error(message.message ?? 'Sandbox worker refused to start'))
        return
      }

      if (message.type === 'result' && message.callId) {
        const entry = pending.get(message.callId)
        if (!entry) return
        pending.delete(message.callId)
        if (message.ok) {
          if (message.mutated) taskOnMutate.get(entry.scope)?.()
          entry.resolve(message.result)
        } else {
          entry.reject(new Error(message.error ?? 'Tool call failed in sandbox worker'))
        }
      }
    }

    const onRuntimeMessage = (message: Parameters<typeof onMessage>[0]) => onMessage(message)

    const onExit = (code: number | null) => {
      clearTimeout(timer)
      const err = new Error(`Sandbox worker exited (code ${code})`)
      rejectReport(err)
      for (const [, entry] of pending) entry.reject(err)
      pending.clear()
    }

    child.on('message', onMessage)
    child.once('exit', onExit)

    child.send({ type: 'job', job })
  })

  const report = await reportPromise

  if (requireEnforced && !report.enforced) {
    child.kill('SIGTERM')
    throw new Error(`Sandbox not enforced: ${report.mechanism}`)
  }

  const makeHandle = (scope: string): LaunchHandle => ({
    callTool: async (tool: string, args: unknown) => {
      assertToolPermission(taskLookups.get(scope), tool, args)

      const callId = String(nextCallId++)
      return new Promise((resolve, reject) => {
        pending.set(callId, { resolve, reject, scope })
        child.send({ type: 'call', callId, tool, args }, (err) => {
          if (err) {
            pending.delete(callId)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
    },
  })

  const handle = makeHandle(SESSION_SCOPE)

  return {
    handle,
    report,
    setTaskPermissions: (lookup) => {
      taskLookups.set(SESSION_SCOPE, lookup)
    },
    setOnMutate: (fn) => {
      taskOnMutate.set(SESSION_SCOPE, fn)
    },
    handleForTask: (taskId, lookup, onMutate) => {
      taskLookups.set(taskId, lookup)
      taskOnMutate.set(taskId, onMutate)
      return makeHandle(taskId)
    },
    releaseTask: (taskId) => {
      taskLookups.delete(taskId)
      taskOnMutate.delete(taskId)
    },
    close: () => {
      for (const [, entry] of pending) entry.reject(new Error('Sandbox session closed'))
      pending.clear()
      if (child.connected) {
        try {
          child.send({ type: 'shutdown' })
        } catch {
          // ignore
        }
      }
      child.kill('SIGTERM')
    },
  }
}

/** Build a permission lookup from a task permissions map (normalized keys). */
export function taskPermissionLookupFrom(
  projectDir: string,
  permissions: Record<string, TaskFilePermissions>,
): (path: string) => TaskFilePermissions | null {
  return (path) => {
    const key = normalizeProjectPath(projectDir, path)
    return permissions[key] ?? null
  }
}
