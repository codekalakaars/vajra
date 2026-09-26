import { chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dbPath, ensureVajraHome } from '../home.js'

/**
 * The one store behind sessions and messages: `~/.vajra/vajra.db`.
 * SQLite (node:sqlite, no dependency) replaces the per-project JSON/JSONL
 * files, so sessions become globally addressable by id and every project
 * shares one store. Connections are cached per resolved path; VAJRA_HOME
 * is re-read on each open so tests can point at a fresh home.
 */
const openDbs = new Map<string, DatabaseSync>()

export interface SessionRow {
  sessionId: string
  projectDir: string
  createdAt: number
  updatedAt: number
  /** The full PersistedSession JSON (schema evolves via migrate() on read). */
  data: string
}

export function openDb(env: NodeJS.ProcessEnv = process.env): DatabaseSync {
  const path = dbPath(env)
  const cached = openDbs.get(path)
  if (cached) return cached
  ensureVajraHome(env)
  const db = new DatabaseSync(path)
  // Session transcripts are private: owner-only, like auth.json. Done before
  // the first write so the -wal/-shm files inherit the mode.
  try {
    chmodSync(path, 0o600)
  } catch {
    // Filesystems without POSIX modes (e.g. NTFS mounts) ignore this.
  }
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      data        TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS sessions_by_project ON sessions(project_dir)')
  db.exec('CREATE INDEX IF NOT EXISTS sessions_by_updated ON sessions(updated_at DESC)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    )
  `)
  openDbs.set(path, db)
  return db
}

/** Close a cached connection (tests that delete their VAJRA_HOME use this). */
export function closeDb(env: NodeJS.ProcessEnv = process.env): void {
  const path = dbPath(env)
  const db = openDbs.get(path)
  if (db) {
    db.close()
    openDbs.delete(path)
  }
}

export function upsertSessionRow(
  row: SessionRow,
  env: NodeJS.ProcessEnv = process.env,
): void {
  openDb(env)
    .prepare(
      `INSERT INTO sessions (session_id, project_dir, created_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         project_dir = excluded.project_dir,
         created_at  = excluded.created_at,
         updated_at  = excluded.updated_at,
         data        = excluded.data`,
    )
    .run(row.sessionId, row.projectDir, row.createdAt, row.updatedAt, row.data)
}

/** Raw session JSON by id (projectDir is deliberately not part of the key). */
export function selectSessionData(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const row = openDb(env)
    .prepare('SELECT data FROM sessions WHERE session_id = ?')
    .get(sessionId) as { data?: string } | undefined
  return row?.data ?? null
}

/**
 * Rows newest-first. A projectDir filter restricts to one project;
 * undefined lists every project.
 */
export function selectSessionRows(
  projectDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionRow[] {
  const db = openDb(env)
  const rows = (
    projectDir === undefined
      ? db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, session_id ASC').all()
      : db
          .prepare(
            'SELECT * FROM sessions WHERE project_dir = ? ORDER BY updated_at DESC, session_id ASC',
          )
          .all(projectDir)
  ) as Array<{ session_id: string; project_dir: string; created_at: number; updated_at: number; data: string }>
  return rows.map(r => ({
    sessionId: r.session_id,
    projectDir: r.project_dir,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    data: r.data,
  }))
}

export function deleteSessionRow(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const db = openDb(env)
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
  const res = db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
  return res.changes > 0
}

export function appendMessageRow(
  sessionId: string,
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const db = openDb(env)
  const next = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ?')
    .get(sessionId) as { next: number }
  db.prepare('INSERT INTO messages (session_id, seq, payload) VALUES (?, ?, ?)').run(
    sessionId,
    next.next,
    payload,
  )
}

export function selectMessagePayloads(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const rows = openDb(env)
    .prepare('SELECT payload FROM messages WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as Array<{ payload: string }>
  return rows.map(r => r.payload)
}
