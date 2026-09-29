/**
 * The foundational layer.
 *
 * Everything else in this package depends on these types and nothing here
 * depends on the rest of the package — which is what makes the import rule in
 * `test/import-rules.test.mjs` enforceable rather than aspirational. `contracts`
 * may import `@codekalakaars/vajra-protocol` (wire schemas sit below every role)
 * and must not import any other subpackage, the CLI, or the TUI.
 */

export type {
  AgentRole,
  WireRole,
  AgentLabel,
  ModelSettings,
  ReasoningEffort,
  AgentInstance,
  TaskScope,
  PermissionGrant,
} from './role.js'

export type {
  AgentRunInput,
  AgentProfile,
  RunBudget,
  AgentResult,
  CoordinationView,
  PlanTaskView,
  TaskStatusView,
  Handoff,
  AgentEvent,
  AgentPhase,
  TokenUsage,
} from './profile.js'

export type {
  ModelClient,
  ModelRequest,
  ModelHandlers,
  ModelEvent,
  ModelResponse,
  ModelMessage,
  ModelToolCall,
  ModelToolSpec,
  TokenUsageShape,
  ToolExecutor,
  CallOptions,
  RuntimeDeps,
} from './model.js'
