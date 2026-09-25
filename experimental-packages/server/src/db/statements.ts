// Prepared-statement cache.
//
// better-sqlite3 compiles a statement every time `prepare` is called and
// caches nothing itself, so the hot paths — a task changing state, a message
// being appended — paid for a fresh compile on every call. Statements are
// keyed by SQL text per database handle, and dropped with the handle.

import type { Statement } from 'better-sqlite3'
import type { SqliteDb } from './client.js'

const caches = new WeakMap<SqliteDb, Map<string, Statement>>()

/**
 * Prepare `sql` against `db`, reusing the compiled statement if this handle
 * has seen it before.
 */
export function stmt(db: SqliteDb, sql: string): Statement {
  let cache = caches.get(db)
  if (!cache) {
    cache = new Map()
    caches.set(db, cache)
  }

  let prepared = cache.get(sql)
  if (!prepared) {
    prepared = db.prepare(sql)
    cache.set(sql, prepared)
  }

  return prepared
}
