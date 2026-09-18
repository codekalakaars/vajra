// Shared constants for agent configuration.
//
// Centralizes magic numbers scattered across loop, manager, and master.

/** Maximum tool calls allowed in the single-agent loop. */
export const MAX_AGENT_TOOL_CALLS = 150

/** Maximum tool calls allowed in the manager conversation loop. */
export const MAX_MANAGER_TOOL_CALLS = 30

/** Default maximum tool calls for a worker task. */
export const DEFAULT_WORKER_TOOL_CALLS = 50

/** Maximum total size (in chars) for summary index entries. */
export const MAX_SUMMARY_TOTAL_SIZE = 16000

/** Maximum lines to return when no specific lines are found in extractRelevantLines. */
export const MAX_CONTEXT_LINES = 50

/** Maximum total context size (in chars) for task context injection. */
export const MAX_TASK_CONTEXT_SIZE = 8000

/** Maximum total dependency context size (in chars). */
export const MAX_DEP_CONTEXT_SIZE = 4000

/** Maximum search results returned by searchSummary. */
export const MAX_SEARCH_RESULTS = 15

/** Default retry config for master task execution. */
export const DEFAULT_MAX_RETRIES = 2

/** Speculative execution confidence threshold. */
export const SPECULATIVE_CONFIDENCE_THRESHOLD = 0.8
