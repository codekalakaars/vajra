import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The build copies schema.sql next to this file's compiled output (see the
// package's build script), so it resolves at the same directory depth
// regardless of whether this runs from src/ (via a TS loader) or dist/.
const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, 'schema.sql')

export type SqliteDb = Database.Database

export function openDb(path: string): SqliteDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(readFileSync(schemaPath, 'utf8'))
  return db
}
