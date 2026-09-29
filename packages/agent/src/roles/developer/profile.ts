import type { AgentProfile, RunBudget } from '../../contracts/index.js'

/**
 * The Developer profile.
 *
 * The Developer is the only role that creates tasks (ADR-0001), and the only
 * one whose job is to understand a repository before anything is written to it.
 * Everything role-specific about it is here: what it is told, what it is shown,
 * what it may call, and what it costs to run.
 *
 * What is *not* here is the data the profile needs. The project summary index
 * and the nested tree are built by code that still lives in
 * `@codekalakaars/vajra-agent-core` and `@codekalakaars/vajra-agent-process`,
 * both of which this migration deletes. Rather than take a dependency on a
 * package that is about to disappear — or on the capability cache inside
 * `~/.vajra`, which plan boundary 6 keeps out of the runtime — the builders
 * arrive as functions from the host. L5 and L7 move the data; until then this
 * is a seam, not a copy.
 */

/** The context the Developer's prompt is built from. */
export interface DeveloperContext {
  /** The rendered project tree, already trimmed to fit the index budget. */
  tree: string
  /** The rendered summary index. */
  summaryText: string
  /** What fraction of the model's window the index was allowed to occupy. */
  summaryBudget: number
  /** How much of the index was shown, and how much existed. */
  summaryShown: number
  summaryTotal: number
  summaryTruncated: boolean
}

export interface DeveloperProfileDeps {
  /**
   * Build the context for one turn. Host-supplied because it reads the project
   * through code this migration is about to relocate.
   */
  buildContext: (input: {
    projectDir: string
    model: string
    summaryIndex: unknown[]
  }) => Promise<DeveloperContext>
  /** The role's instructions. */
  systemPrompt: (context: DeveloperContext) => string
  /**
   * The staged summary index, for `search_files`.
   *
   * The Developer answers `search_files` from the index it was given rather
   * than from the tool executor, so a search costs no tool call and cannot be
   * confused with a file read.
   */
  searchSummary: (summaryIndex: unknown[], query: string) => string
}

export const DEVELOPER_BUDGET: RunBudget = {
  maxToolCalls: 30,
  maxIterations: 60,
  maxWallMs: 5 * 60 * 1000,
  // `search_files` is answered from the staged index, so charging it would
  // price a lookup the model got for free.
  freeTools: ['search_files'],
}

export function createDeveloperProfile(deps: DeveloperProfileDeps): AgentProfile<DeveloperContext> {
  return {
    role: 'developer',
    buildSystemPrompt: context => deps.systemPrompt(context),
    // `projectDir` and `summaryIndex` travel in `extra` rather than on
    // `AgentRunInput`, because they are role inputs: a Worker has no project
    // index and a Manager has no project directory to scan. The contract carries
    // what every run needs; a role carries the rest.
    buildContext: input =>
      deps.buildContext({
        projectDir: String(input.extra?.projectDir ?? ''),
        model: input.model.model,
        summaryIndex: (input.extra?.summaryIndex as unknown[]) ?? [],
      }),
    allowedTools: DEVELOPER_TOOLS,
    budget: DEVELOPER_BUDGET,
    extra: { searchSummary: deps.searchSummary },
  }
}

/**
 * The Developer's tool catalog.
 *
 * The mutation surface is stubs and the plan: it may read, search, measure a
 * baseline, write a stub, delete a stub, and propose a plan. It may not write a
 * real file, and it may not run a command — implementation is the Worker's.
 *
 * This list is what the model is *offered*. It is not the authorization: a
 * call is also checked against the permission grant, and the Developer runs
 * with a stub-scoped permission set so a hallucinated `write_file` cannot touch
 * a file it never declared.
 */
export const DEVELOPER_TOOLS: readonly string[] = [
  'read_file',
  'list_files',
  'search_files',
  'search_content',
  'run_baseline',
  'write_stub',
  'delete_stub',
  'propose_plan',
]
