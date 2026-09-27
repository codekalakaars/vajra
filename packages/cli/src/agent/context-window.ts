/**
 * Context window sizes by model, for the usage meter and for compaction.
 *
 * The number is the model's, not ours: the catalog carries `limit.context` for
 * every model it knows, so this is a lookup rather than a guess — the constant
 * that used to live here (128k for every model, while the screen measured
 * against 200k) is gone. A model the catalog has never heard of — a cold cache,
 * or an id that appeared after the last fetch — falls back to the catalog's
 * conservative default, because under-estimating a window truncates a
 * conversation the model could have handled, and over-estimating only makes
 * compaction happen early.
 */
import { contextLimitFor } from '../models/catalog.js'

export function getModelLimit(model: string): number {
  return contextLimitFor(model)
}
