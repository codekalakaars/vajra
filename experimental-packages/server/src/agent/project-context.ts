// Cached project tree + summary index.
//
// Both the single-agent loop and the manager's first turn built these from
// scratch: a full directory scan plus a read of every source file, on every
// call. scanProject is a synchronous native call, so the scan also blocks the
// event loop — and with it every other client — for its duration.
//
// Entries are cached per directory for a short window and rebuilt after that,
// so a burst of turns pays for one scan while a long-lived project still
// picks up files that workers created.

import { scanProject } from '../native.js'
import { buildNestedTree } from './tree.js'
import { buildSummaryIndex, type SummaryEntry } from './summary.js'

export interface ProjectContext {
  tree: string
  summaryIndex: SummaryEntry[]
}

interface CacheEntry {
  builtAt: number
  /** Shared while the build is in flight, so concurrent callers scan once. */
  context: Promise<ProjectContext>
}

const TTL_MS = Number(process.env.VAJRA_PROJECT_SCAN_TTL_MS) || 30_000

const cache = new Map<string, CacheEntry>()

async function build(projectDir: string): Promise<ProjectContext> {
  try {
    const entries = scanProject(projectDir)
    return {
      tree: buildNestedTree(entries),
      summaryIndex: await buildSummaryIndex(projectDir, entries),
    }
  } catch {
    return { tree: '(unable to read project tree)', summaryIndex: [] }
  }
}

/**
 * The project's tree and summary index, rebuilt at most once per TTL.
 */
export function projectContext(projectDir: string): Promise<ProjectContext> {
  const cached = cache.get(projectDir)
  if (cached && Date.now() - cached.builtAt < TTL_MS) {
    return cached.context
  }

  const entry: CacheEntry = { builtAt: Date.now(), context: build(projectDir) }
  cache.set(projectDir, entry)

  // A failed build should not be cached for the rest of the window.
  entry.context.catch(() => cache.delete(projectDir))

  return entry.context
}

/** Drop a directory's cached context — call after workers have changed it. */
export function invalidateProjectContext(projectDir?: string): void {
  if (projectDir === undefined) cache.clear()
  else cache.delete(projectDir)
}
