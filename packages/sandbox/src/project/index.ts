// The repository index, tool specs and plan types: pure functions, no I/O.
//
// This package contains zero I/O: no file reads, no network calls, no
// database operations. It is safe for both synchronous (CLI) and
// asynchronous (server) consumers.

export { buildNestedTree, DEFAULT_TREE_DEPTH } from './tree.js'

export {
  type SummaryEntry,
  MIN_INDEX_BUDGET_CHARS,
  MAX_INDEX_BUDGET_CHARS,
  DEFAULT_INDEX_BUDGET_CHARS,
  deriveIndexBudget,
  SYMBOL_CAP,
  SKIP_DIRS,
  SKIP_EXTENSIONS,
  SKIP_SUFFIXES,
  extractSymbols,
  countImports,
  countExports,
  getPreview,
  shouldSkipFile,
  formatSummaryIndexHierarchical,
  renderSummaryIndex,
  type SummaryIndexRender,
  searchSummary,
} from './summary.js'

export {
  type TaskStatus,
  type TaskState,
  type QueueStatus,
  type AgentRole,
  type AgentStatus,
  type AgentState,
} from './plan.js'

export {
  type ParsedToolCall,
  type ParseToolCallResult,
  type RawToolCall,
  type OpenAiToolSpec,
  parseToolCall,
  getToolSpecs,
  getDeveloperToolSpecs,
  getWorkerToolSpecs,
} from './tools.js'
