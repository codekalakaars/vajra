import type {
  
  
  ProjectFileEntry
} from '@codekalakaars/vajra-protocol'
import { deriveIndexBudget } from '@codekalakaars/vajra-sandbox'
import { getModelLimit } from '../model/context-window.js'
import {
  
  scanProject,
  buildSummaryIndex,
  formatSummaryIndexHierarchical,
  renderSummaryIndex,
  
  
  type SummaryEntry
} from '@codekalakaars/vajra-sandbox'
import { buildNestedTree } from '@codekalakaars/vajra-sandbox'

/**
 * Explicit depth for the project tree. Four levels keeps a four-deep package
 * layout fully named; the shrink-to-fit loop in buildInitialPromptContext only
 * ever renders shallower than this.
 */
const PROJECT_TREE_DEPTH = 4

/**
 * Build a summary index that can actually fill `budget`.
 *
 * buildSummaryIndex truncates every call to a fixed internal raw-size cap
 * calibrated to the old 4,000-char formatted budget, so one call can only ever
 * show a sliver of the repo — that was the 7.5% → 5.9% coverage regression.
 * Re-run it over the entries not yet indexed until the formatted index would
 * fill the budget or the repo is exhausted. Every call ranks its input the
 * same way, so the union is the global rank order cut at the budget.
 */
function buildIndexWithinBudget(
  projectDir: string,
  entries: ProjectFileEntry[],
  budget: number,
): SummaryEntry[] {
  const index: SummaryEntry[] = []
  const seen = new Set<string>()
  let remaining = entries

  while (formatSummaryIndexHierarchical(index, budget).length < budget) {
    const batch = buildSummaryIndex(projectDir, remaining)
    if (batch.length === 0) break
    for (const entry of batch) {
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      index.push(entry)
    }
    remaining = remaining.filter(entry => !seen.has(entry.path))
  }

  return index
}

export interface InitialPromptContext {
  tree: string
  summaryText: string
  summaryBudget: number
  /**
   * How much of the staged index actually reached the prompt.
   *
   * `summaryIndex` can be larger than the budget can render — a repository that
   * outgrows the cap is trimmed silently, and the Developer then reasons about a
   * project it cannot see. These make that condition observable instead.
   */
  summaryShown: number
  summaryTotal: number
  summaryTruncated: boolean
}

/**
 * Build the pieces of the Developer's system prompt: a summary index sized to
 * this model's derived budget, and a project tree that never outgrows it —
 * the tree is names-only, so the signal-dense index always wins the space.
 */
export function buildInitialPromptContext(
  projectDir: string,
  summaryIndex: SummaryEntry[],
  model: string,
): InitialPromptContext {
  const summaryBudget = deriveIndexBudget(getModelLimit(model))

  let entries: ProjectFileEntry[] = []
  let tree = '(unable to read project tree)'
  try {
    entries = scanProject(projectDir)
    tree = buildNestedTree(entries, PROJECT_TREE_DEPTH)
  } catch {
    entries = []
  }

  if (entries.length > 0 && summaryIndex.length === 0) {
    try {
      summaryIndex.push(...buildIndexWithinBudget(projectDir, entries, summaryBudget))
    } catch {
      // Indexing failed; the prompt falls back to whatever the caller staged.
    }
  }

  const render = renderSummaryIndex(summaryIndex, summaryBudget)
  const summaryText = render.text

  // Names-only context must never cost more than the indexed symbols,
  // exports and previews it accompanies.
  let depth = PROJECT_TREE_DEPTH
  while (
    entries.length > 0 &&
    depth > 1 &&
    tree.length > Math.min(summaryText.length, summaryBudget)
  ) {
    depth -= 1
    tree = buildNestedTree(entries, depth)
  }

  return {
    tree,
    summaryText,
    summaryBudget,
    summaryShown: render.shown,
    summaryTotal: render.total,
    summaryTruncated: render.truncated,
  }
}
