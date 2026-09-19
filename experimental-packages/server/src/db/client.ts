import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, 'schema.sql')
const migrationsDir = join(here, 'migrations')

export type SqliteDb = Database.Database

/**
 * Ordered list of migration files. Each entry is the filename inside
 * `migrations/`. New migrations must be appended here and numbered
 * sequentially.
 */
const MIGRATIONS = [
  '001-add-task-columns.sql',
]

/**
 * Apply any pending migrations. Safe to call on every open — already-applied
 * migrations are skipped.
 */
function migrate(db: SqliteDb): void {
  // Ensure the version tracking table exists.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)

  const current = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`,
  ).get() as { v: number }

  for (const file of MIGRATIONS) {
    const migrationVersion = parseInt(file.split('-')[0], 10)
    if (migrationVersion <= current.v) continue

    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'))

    db.transaction(() => {
      for (const statement of statements) {
        try {
          db.exec(statement)
        } catch (e: any) {
          // "duplicate column name" means the column already exists — skip it.
          // This handles databases that were created with the old schema.sql
          // that already includes the new columns.
          if (e.code !== 'SQLITE_ERROR' || !String(e.message).includes('duplicate column')) {
            throw e
          }
        }
      }
      db.prepare(
        `INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`,
      ).run(migrationVersion, Date.now())
    })()
  }
}

export function openDb(path: string): SqliteDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  // Create the base schema (IF NOT EXISTS makes this idempotent).
  db.exec(readFileSync(schemaPath, 'utf8'))

  // Apply any pending migrations.
  migrate(db)

  return db
}

/**
 * Run `fn` inside a better-sqlite3 transaction. Returns whatever `fn` returns.
 *
 * better-sqlite3 transactions are reentrant: calling `db.transaction(fn)` from
 * inside an already-open transaction simply nests — no deadlock, no extra lock
 * acquisition. This makes it safe to compose smaller transactional helpers
 * inside a larger one.
 */
export function runInTransaction<T>(db: SqliteDb, fn: () => T): T {
  return db.transaction(fn)()
}

/**
 * Reconcile stale sessions on boot. Sessions left in 'executing' or 'running'
 * status from a previous crash cannot be resumed — mark them failed.
 */
export function reconcileStaleSessions(db: SqliteDb): void {
  const stale = db.prepare(
    `SELECT id FROM sessions WHERE status IN ('executing', 'running')`
  ).all() as Array<{ id: string }>

  if (stale.length === 0) return

  const now = Date.now()
  const tx = db.transaction(() => {
    for (const { id } of stale) {
      db.prepare(`UPDATE sessions SET status = 'failed', ended_at = ? WHERE id = ?`).run(now, id)
      db.prepare(`UPDATE tasks SET status = 'failed', completed_at = ? WHERE session_id = ? AND status IN ('assigned', 'running')`).run(now, id)
      db.prepare(`UPDATE agents SET status = 'failed', ended_at = ? WHERE session_id = ? AND status = 'running'`).run(now, id)
    }
  })
  tx()
}
