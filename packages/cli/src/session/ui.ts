import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import { isAbsolute, relative, basename, sep } from 'node:path'

/** Streaming/output methods shared by runSession and executeTask. */
export interface SessionStreamer {
  onTextDelta(text: string): void
  onThinkingDelta(text: string): void
  /** Flush buffered assistant text. */
  finishLine(): void
  /** Drop unflushed buffer without printing. */
  discardBuffer(): void
  info(message: string): void
  success(message: string): void
  error(message: string): void
  warning(message: string): void
  /** Blank line (report separators). */
  newline(): void
}

/** Structured execution progress so frontends can render a task list. */
export type TaskEvent =
  | { type: 'start'; index: number; total: number; title: string }
  | { type: 'done'; title: string }
  | { type: 'failed'; title: string }
  | { type: 'skipped'; title: string }
  | { type: 'retry'; title: string; attempt: number; max: number }
  | { type: 'no-changes'; title: string }

/**
 * Port implemented by frontends (CLI readline adapter, TUI). runSession talks
 * to the UI only through this interface — no readline, no console, no Ink.
 */
export interface SessionUI extends SessionStreamer {
  banner(): void
  /**
   * Initial task prompt when none was passed on the command line.
   * 'first' = "What would you like me to work on?",
   * 'reentry' = empty answer loop: "Please enter a task (or type "exit")".
   */
  askInitialTask(kind: 'first' | 'reentry'): Promise<string>
  /** Follow-up user turn during the conversation loop. */
  askUserMessage(): Promise<string>
  /** Render the proposed plan before confirmation. */
  showPlan(plan: DeveloperPlan): void
  /** Ask [y/N] for the plan. Anything but y/yes must come back as 'n'. */
  askConfirmPlan(): Promise<'y' | 'n'>
  /** Ask for feedback after a rejected plan. */
  askRejectFeedback(): Promise<string>
  /** Task execution progress (CLI maps this back to log lines). */
  onTaskEvent(event: TaskEvent): void
  /**
   * Sub-task progress: provider round-trips, individual tool calls, phases.
   * Every event carries its origin so renderers can group once tasks run in
   * parallel — a flat interleaved log is worse than silence.
   */
  onAgentEvent(event: AgentEvent): void
}

/** Who is acting. Renderers group by this once tasks run in parallel. */
export interface AgentLabel {
  role: 'developer' | 'worker'
  /** Present for workers; identifies the row to update. */
  taskId?: string
  title?: string
}

export type AgentPhase = 'scanning' | 'indexing' | 'planning' | 'validating' | 'executing'

export type AgentEvent =
  /** A provider round-trip began. */
  | { type: 'llm-start'; agent: AgentLabel; round: number }
  /** …and ended. `ms` is wall-clock; `budget` is round N of the loop's cap. */
  | { type: 'llm-end'; agent: AgentLabel; round: number; ms: number; budget?: number }
  /** A tool is about to run. `summary` is the one argument worth showing. */
  | { type: 'tool-start'; agent: AgentLabel; callId: string; tool: string; summary: string }
  /** Tool finished. `detail` is a short outcome: "4.2 KB", "3 matches", "exit 1". */
  | {
      type: 'tool-end'
      agent: AgentLabel
      callId: string
      tool: string
      ok: boolean
      ms: number
      detail?: string
    }
  /** Coarse phase, for the status line. */
  | { type: 'phase'; agent: AgentLabel; phase: AgentPhase }
  /** Nothing has happened for a while — emit elapsed so the screen still moves. */
  | { type: 'heartbeat'; agent: AgentLabel; elapsedMs: number }

const MASKED_STUB = '[REDACTED: masked file — contents withheld]'
const SUMMARY_MAX = 60
const HEARTBEAT_MS = 750

function clamp(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Stable key per agent: one row in a renderer, whatever the role. */
export function agentKey(agent: AgentLabel): string {
  return agent.taskId ?? agent.role
}

/** What a renderer calls this agent in a row or a `[prefix]`. */
export function agentDisplay(agent: AgentLabel): string {
  if (agent.role === 'developer') return 'developer'
  return agent.title ?? agent.taskId ?? 'worker'
}

/** `2.4s` under a minute, `1m 05s` after — identical in both renderers. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** `4 tasks` for propose_plan; empty when the arguments are unreadable. */
export function summarizePlanTaskCount(args: unknown): string {
  const tasks = (args as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(tasks)) return ''
  return `${tasks.length} task${tasks.length === 1 ? '' : 's'}`
}

/**
 * Fire a heartbeat while the caller is blocked in a tool call. chat.ts has its
 * own timer for provider round-trips; a 300-second `run_command` would be just
 * as silent without this. Returns the stop function — call it in a `finally`.
 */
export function startHeartbeat(
  emit: (event: AgentEvent) => void,
  agent: AgentLabel,
  intervalMs = HEARTBEAT_MS,
): () => void {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    emit({ type: 'heartbeat', agent, elapsedMs: Date.now() - startedAt })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Show a path the way the plan does — project-relative. An absolute path is
 * noise and can leak the user's home directory into a shared terminal, so
 * anything outside the project falls back to its basename.
 */
export function projectRelativePath(projectDir: string, path: string): string {
  if (!path) return path
  if (!isAbsolute(path)) return clamp(path.replace(/^\.\//, ''), 120)
  const rel = relative(projectDir, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return basename(path)
  return rel.split(sep).join('/')
}

function countMatches(text: string): number {
  let n = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.startsWith('(capped at ') || line.startsWith('Error:')) continue
    n++
  }
  return n
}

/** One short string for the `→` line: the argument worth seeing, not the tool. */
export function summarizeToolCall(tool: string, args: unknown, projectDir: string): string {
  const a = (args ?? {}) as Record<string, unknown>
  const str = (key: string): string => (typeof a[key] === 'string' ? (a[key] as string) : '')
  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'create_dir':
      return projectRelativePath(projectDir, str('path'))
    case 'list_files':
      return projectRelativePath(projectDir, str('path') || '.') || '.'
    case 'search_files':
    case 'search_content':
      return clamp(`"${str('query')}"`)
    case 'run_command':
    case 'run_baseline':
      return clamp(str('command'))
    default:
      return ''
  }
}

/** Short outcome for the `←` line. Never carries file contents. */
export function summarizeToolResult(
  tool: string,
  args: unknown,
  result: unknown,
  ms: number,
): { ok: boolean; detail: string } {
  const a = (args ?? {}) as Record<string, unknown>
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  const seconds = (ms / 1000).toFixed(1)

  if (typeof text === 'string' && text.startsWith('Error:')) {
    return { ok: false, detail: clamp(text, 80) }
  }

  switch (tool) {
    case 'read_file':
      return {
        ok: true,
        detail: text === MASKED_STUB ? 'masked' : formatBytes(Buffer.byteLength(text, 'utf8')),
      }
    case 'write_file':
    case 'edit_file':
      return { ok: true, detail: lineDelta(tool, a) }
    case 'list_files': {
      const n = safeArrayLength(text)
      return { ok: true, detail: n === null ? 'ok' : `${n} entr${n === 1 ? 'y' : 'ies'}` }
    }
    case 'search_content': {
      const n = text === 'No matches found.' ? 0 : countMatches(text)
      return { ok: true, detail: `${n} match${n === 1 ? '' : 'es'}` }
    }
    case 'search_files': {
      const n = countMatches(text)
      return { ok: true, detail: `${n} result${n === 1 ? '' : 's'}` }
    }
    case 'run_command':
    case 'run_baseline': {
      const parsed = parseExit(text)
      if (parsed === null) return { ok: false, detail: 'malformed result' }
      const exit = `exit ${parsed.exitCode}`
      return {
        ok: parsed.ok,
        detail: tool === 'run_baseline' ? `${exit} (expected)` : `${exit} · ${seconds}s`,
      }
    }
    default:
      return { ok: true, detail: clamp(text, 40) || 'ok' }
  }
}

/**
 * Line delta of what was written. For an edit it is the replaced block's own
 * line count — the tools report no diff, and re-reading the file here would
 * race the next write.
 */
function lineDelta(tool: string, a: Record<string, unknown>): string {
  if (tool === 'edit_file') {
    const removed = typeof a.oldString === 'string' ? a.oldString.split('\n').length : 0
    const added = typeof a.newString === 'string' ? a.newString.split('\n').length : 0
    if (added === 0 && removed === 0) return 'ok'
    return `+${added} −${removed} line${Math.max(added, removed) === 1 ? '' : 's'}`
  }
  const content = typeof a.content === 'string' ? a.content : ''
  const lines = content === '' ? 0 : content.split('\n').length
  return lines > 0 ? `+${lines} line${lines === 1 ? '' : 's'}` : 'ok'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function safeArrayLength(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed.length : null
  } catch {
    return null
  }
}

function parseExit(text: string): { ok: boolean; exitCode: number } | null {
  try {
    const parsed = JSON.parse(text) as { exitCode?: number; signal?: string | null }
    if (typeof parsed.exitCode !== 'number') return null
    return { ok: parsed.exitCode === 0 && !parsed.signal, exitCode: parsed.exitCode }
  } catch {
    return null
  }
}
