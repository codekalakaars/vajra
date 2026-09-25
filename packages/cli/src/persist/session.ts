import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { DeveloperPlan, TaskStatus } from '@codekalakaars/vajra-protocol'

/** P4: persisted state lives at `.vajra/sessions/<sessionId>.json`. */
export const SESSION_SCHEMA_VERSION = 2
/** v1 records are still loadable and are migrated forward on read. */
export const LEGACY_SESSION_SCHEMA_VERSION = 1
export const VAJRA_DIR = '.vajra'
export const MISSING_FILE_HASH = '__missing__'
export const DIRECTORY_FILE_HASH = '__directory__'
export const UNREADABLE_FILE_HASH = '__unreadable__'
export const SESSIONS_SUBDIR = 'sessions'
export const INDEX_SUBDIR = 'index'

/** Session ids are path components: no separators, no traversal, no hidden files. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface PersistedTask {
  status: TaskStatus
  startedAt?: number
  completedAt?: number
  error?: string
  /** v2: rollback baselines, so an interrupted task stays recoverable. */
  baselines?: Record<string, string | null>
}

export interface PersistedEvidence {
  filesRead: Record<string, string>
  baselines: Record<string, number>
}

/** Where the session was when it was last written. */
export type SessionPhase = 'conversing' | 'awaiting-approval' | 'executing' | 'finished'

/** Resume must not silently change how the session runs. */
export interface PersistedConfig {
  model: string
  timeoutSeconds: number
  concurrency?: number
  allowUnenforced: boolean
}

export interface GitState {
  head: string
  dirty: boolean
}

export interface PersistedSession {
  version: 2
  sessionId: string
  projectDir: string
  createdAt: number
  updatedAt: number
  config: PersistedConfig
  phase: SessionPhase
  plan: DeveloperPlan | null
  evidence: PersistedEvidence | null
  tasks: Record<string, PersistedTask & { baselines?: Record<string, string | null> }>
  /** path → sha256 or a file-state marker for missing/directory/unreadable paths. */
  fileHashes: Record<string, string>
  summaryFingerprint: string | null
  git?: GitState
}

/** One line of the append-only conversation log. */
export interface PersistedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

export interface SessionSummary {
  sessionId: string
  createdAt: number
  updatedAt: number
  status: string
  phase: SessionPhase
  planTitle: string | null
  projectDir: string
  done: number
  total: number
}

/** In-memory evidence (TASK_SPEC §4) — Maps on purpose, Records on disk. */
export interface EvidenceMaps {
  filesRead: Map<string, string>
  baselines: Map<string, number>
}

export function assertSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`)
  }
  return sessionId
}

export function sessionsDir(projectDir: string): string {
  if (typeof projectDir !== 'string' || !projectDir) {
    throw new Error('projectDir is required')
  }
  return join(resolve(projectDir), VAJRA_DIR, SESSIONS_SUBDIR)
}

export function indexDir(projectDir: string): string {
  if (typeof projectDir !== 'string' || !projectDir) {
    throw new Error('projectDir is required')
  }
  return join(resolve(projectDir), VAJRA_DIR, INDEX_SUBDIR)
}

export function sessionFile(projectDir: string, sessionId: string): string {
  return join(sessionsDir(projectDir), `${assertSessionId(sessionId)}.json`)
}

/** Conversation history is append-only, so saving does not rewrite the record. */
export function messagesFile(projectDir: string, sessionId: string): string {
  return join(sessionsDir(projectDir), `${assertSessionId(sessionId)}.messages.jsonl`)
}

export function indexFile(projectDir: string, fingerprint: string): string {
  return join(indexDir(projectDir), `${assertSessionId(fingerprint)}.json`)
}

/** sha256 of a file's bytes, or null when it cannot be read. */
export function hashFile(absPath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

export type FileState =
  | { kind: 'file'; hash: string }
  | { kind: 'directory' }
  | { kind: 'missing' }
  | { kind: 'unreadable' }

export function inspectFile(absPath: string): FileState {
  try {
    if (statSync(absPath).isDirectory()) return { kind: 'directory' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable' }
  }
  const hash = hashFile(absPath)
  return hash === null ? { kind: 'unreadable' } : { kind: 'file', hash }
}

export function hashContent(content: string | null): string | null {
  return content === null ? null : createHash('sha256').update(content, 'utf-8').digest('hex')
}

const PHASES: ReadonlySet<string> = new Set<SessionPhase>([
  'conversing',
  'awaiting-approval',
  'executing',
  'finished',
])

const CONFIG_DEFAULTS: PersistedConfig = {
  model: '',
  timeoutSeconds: 300,
  allowUnenforced: false,
}

/**
 * Normalise anything we find on disk into the v2 shape. A v1 record has no
 * config, phase, hashes or updatedAt; it migrates forward with the defaults
 * rather than becoming unreadable.
 */
function migrate(raw: unknown, expectedId?: string): PersistedSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  if (typeof s.sessionId !== 'string' || typeof s.projectDir !== 'string') return null
  if (expectedId !== undefined && s.sessionId !== expectedId) return null
  if (typeof s.createdAt !== 'number' || !Number.isFinite(s.createdAt)) return null
  if (!s.tasks || typeof s.tasks !== 'object' || Array.isArray(s.tasks)) return null

  const version = s.version
  if (version !== 1 && version !== 2) return null

  const phase = typeof s.phase === 'string' && PHASES.has(s.phase)
    ? (s.phase as SessionPhase)
    : s.plan
      ? 'awaiting-approval'
      : 'conversing'

  const rawConfig = (s.config ?? {}) as Record<string, unknown>
  const config: PersistedConfig = {
    model: typeof rawConfig.model === 'string' ? rawConfig.model : CONFIG_DEFAULTS.model,
    timeoutSeconds:
      typeof rawConfig.timeoutSeconds === 'number' && Number.isFinite(rawConfig.timeoutSeconds)
        ? rawConfig.timeoutSeconds
        : CONFIG_DEFAULTS.timeoutSeconds,
    allowUnenforced: rawConfig.allowUnenforced === true,
    ...(typeof rawConfig.concurrency === 'number' && Number.isFinite(rawConfig.concurrency)
      ? { concurrency: rawConfig.concurrency }
      : {}),
  }

  const rawHashes = (s.fileHashes ?? {}) as Record<string, unknown>
  const fileHashes: Record<string, string> = {}
  for (const [path, hash] of Object.entries(rawHashes)) {
    if (typeof hash === 'string') fileHashes[path] = hash
  }

  return {
    version: SESSION_SCHEMA_VERSION,
    sessionId: s.sessionId,
    projectDir: s.projectDir,
    createdAt: s.createdAt,
    updatedAt: typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt)
      ? s.updatedAt
      : s.createdAt,
    config,
    phase,
    plan: (s.plan as DeveloperPlan | null) ?? null,
    evidence: (s.evidence as PersistedEvidence | null) ?? null,
    tasks: s.tasks as PersistedSession['tasks'],
    fileHashes,
    summaryFingerprint: typeof s.summaryFingerprint === 'string' ? s.summaryFingerprint : null,
    ...(s.git && typeof s.git === 'object' ? { git: s.git as GitState } : {}),
  }
}

/**
 * Write tmp, fsync, rename over the target. A crash at any point leaves either
 * the previous good file or a stray `.tmp` — never a half-written target.
 */
function writeFileAtomic(target: string, data: string): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${nextTmpSeq()}.tmp`
  let ok = false
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
    ok = true
  } finally {
    if (!ok) rmSync(tmp, { force: true })
  }
}

let tmpSeq = 0
function nextTmpSeq(): number {
  tmpSeq = (tmpSeq + 1) % 0xffff
  return tmpSeq
}

/** Persist the whole session atomically (P4/P5: a crash never loses a completed task). */
export function saveSession(s: PersistedSession): void {
  if (!s || typeof s !== 'object') {
    throw new Error('saveSession: session must be an object')
  }
  if (s.version !== SESSION_SCHEMA_VERSION) {
    throw new Error(`Unsupported session version: ${String((s as { version?: unknown }).version)}`)
  }
  if (typeof s.projectDir !== 'string' || !s.projectDir) {
    throw new Error('saveSession: projectDir is required')
  }
  if (!Number.isFinite(s.createdAt)) {
    throw new Error('saveSession: createdAt must be a finite epoch-ms number')
  }
  if (
    s.tasks instanceof Map ||
    s.evidence?.filesRead instanceof Map ||
    s.evidence?.baselines instanceof Map
  ) {
    throw new Error('saveSession: Map values do not survive JSON — use evidenceToRecord() first')
  }
  const target = sessionFile(s.projectDir, s.sessionId)
  // Serialise before touching disk: a stringify failure writes nothing at all.
  const data = `${JSON.stringify(s, null, 2)}\n`
  writeFileAtomic(target, data)
}

/**
 * Append one message to the conversation log. A blank line is not a message,
 * so a partially written trailing line is simply ignored on read rather than
 * resurrecting half a tool call.
 */
export function appendMessage(
  sessionId: string,
  projectDir: string,
  message: PersistedMessage,
): void {
  const file = messagesFile(projectDir, sessionId)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(message)}\n`, 'utf-8')
}

export function loadMessages(sessionId: string, projectDir: string = process.cwd()): PersistedMessage[] {
  const file = messagesFile(projectDir, sessionId)
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: PersistedMessage[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as PersistedMessage
      if (parsed && typeof parsed === 'object' && typeof parsed.role === 'string') {
        out.push(parsed)
      }
    } catch {
      // A truncated trailing line from a crash: ignore it, keep the rest.
    }
  }
  return out
}

export function deleteSession(sessionId: string, projectDir: string = process.cwd()): boolean {
  const meta = sessionFile(projectDir, sessionId)
  if (!existsSync(meta)) return false
  rmSync(meta, { force: true })
  rmSync(messagesFile(projectDir, sessionId), { force: true })
  return true
}

/**
 * A cheap repo fingerprint: file count + newest mtime. Stable enough to reuse a
 * cached summary index, and it costs one directory walk.
 */
export function repoFingerprint(projectDir: string): string {
  let count = 0
  let newest = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === VAJRA_DIR || entry.name === 'node_modules') {
        continue
      }
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), depth + 1)
        continue
      }
      count++
      try {
        const mtime = statSync(join(dir, entry.name)).mtimeMs
        if (mtime > newest) newest = mtime
      } catch {
        // Unreadable entry — it simply does not contribute.
      }
    }
  }
  walk(resolve(projectDir), 0)
  return createHash('sha256').update(`${count}:${Math.floor(newest)}`).digest('hex').slice(0, 32)
}

export interface SummaryIndexCacheEntry {
  path: string
  symbols: string[]
  preview: string
  lineCount: number
  importCount: number
  exportCount: number
}

export interface SummaryIndexCache {
  version: 1
  fingerprint: string
  createdAt: number
  entries: SummaryIndexCacheEntry[]
}

export function loadSummaryIndexCache(
  projectDir: string,
  fingerprint: string,
): SummaryIndexCache | null {
  let text: string
  try {
    text = readFileSync(indexFile(projectDir, fingerprint), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as SummaryIndexCache
    if (parsed?.version !== 1 || parsed.fingerprint !== fingerprint) return null
    if (!Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveSummaryIndexCache(projectDir: string, cache: SummaryIndexCache): void {
  const target = indexFile(projectDir, cache.fingerprint)
  writeFileAtomic(target, `${JSON.stringify(cache)}\n`)
}

/** HEAD + dirty flag when git is available; null when it is not. */
export function readGitState(projectDir: string): GitState | null {
  try {
    // Lazy require: git is optional and this runs off the hot path.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const cwd = resolve(projectDir)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    let dirty = false
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      dirty = status.trim().length > 0
    } catch {
      dirty = false
    }
    return { head, dirty }
  } catch {
    return null
  }
}

function parseSession(text: string, expectedId?: string): PersistedSession | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  return migrate(raw, expectedId)
}

/** Load a session (v1 or v2), or null when missing, unreadable, or malformed. */
export function loadSession(sessionId: string, projectDir: string = process.cwd()): PersistedSession | null {
  const file = sessionFile(projectDir, sessionId)
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return parseSession(text, sessionId)
}

/** The most recently updated session for this project, or null. */
export function latestSession(projectDir: string = process.cwd()): PersistedSession | null {
  const [first] = listSessions(projectDir)
  if (!first) return null
  return loadSession(first.sessionId, projectDir)
}

/** Session-level status derived from the per-task statuses. */
export function deriveSessionStatus(tasks: Record<string, PersistedTask> | null | undefined): string {
  const list = tasks ? Object.values(tasks) : []
  if (list.length === 0) return 'pending'
  if (list.some(t => t.status === 'running' || t.status === 'assigned')) return 'running'
  if (list.some(t => t.status === 'failed')) return 'failed'
  if (list.every(t => t.status === 'done' || t.status === 'skipped')) return 'done'
  return 'pending'
}

/**
 * List persisted sessions, newest first. Stray `.tmp` files from an interrupted
 * write are ignored; an unparseable `.json` is reported with status 'corrupt'
 * rather than silently dropped.
 */
export function listSessions(projectDir: string = process.cwd()): SessionSummary[] {
  const dir = sessionsDir(projectDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: SessionSummary[] = []
  for (const name of names) {
    if (name.endsWith('.tmp') || !name.endsWith('.json')) continue
    // The conversation log lives beside the metadata; it is not a session.
    if (name.endsWith('.messages.jsonl')) continue
    const file = join(dir, name)
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    const parsed = parseSession(text)
    if (parsed) {
      const tasks = Object.values(parsed.tasks)
      out.push({
        sessionId: parsed.sessionId,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        status: deriveSessionStatus(parsed.tasks),
        phase: parsed.phase,
        planTitle: parsed.plan?.tasks?.[0]?.title ?? null,
        projectDir: parsed.projectDir,
        done: tasks.filter(t => t.status === 'done' || t.status === 'skipped').length,
        total: tasks.length,
      })
    } else {
      let createdAt = 0
      try {
        createdAt = statSync(file).mtimeMs
      } catch {
        createdAt = 0
      }
      out.push({
        sessionId: name.slice(0, -'.json'.length),
        createdAt,
        updatedAt: createdAt,
        status: 'corrupt',
        phase: 'conversing',
        planTitle: null,
        projectDir: resolve(projectDir),
        done: 0,
        total: 0,
      })
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
  return out
}

/** In-memory evidence (Maps) -> JSON-safe evidence (Records). */
export function evidenceToRecord(e: {
  filesRead: ReadonlyMap<string, string>
  baselines: ReadonlyMap<string, number>
}): PersistedEvidence {
  if (!(e.filesRead instanceof Map) || !(e.baselines instanceof Map)) {
    throw new Error('evidenceToRecord: expected Map values — a Record is already JSON-safe')
  }
  return {
    filesRead: Object.fromEntries(e.filesRead),
    baselines: Object.fromEntries(e.baselines),
  }
}

/** JSON-safe evidence (Records) -> in-memory evidence (Maps). */
export function evidenceFromRecord(e: PersistedEvidence | null | undefined): EvidenceMaps {
  if (!e) return { filesRead: new Map(), baselines: new Map() }
  return {
    filesRead: new Map(Object.entries(e.filesRead ?? {})),
    baselines: new Map(Object.entries(e.baselines ?? {})),
  }
}
