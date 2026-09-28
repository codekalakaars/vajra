// @codekalakaars/vajra-agent-process — spawn a kernel-confined agent.
//
// One call, `spawnAgent`, forks a worker that applies Landlock to itself
// before touching anything, then answers tool calls over IPC. The caller
// supplies policy and gets back a handle that cannot act outside it.
//
//   const agent = await spawnAgent(projectDir, sessionId)
//   const text  = await agent.handle.callTool('read_file', { path: 'README.md' })
//   agent.close()
//
// Two entry points, differing only in blast radius: `spawnAgent` is one worker,
// `spawnAgentPool` is one per in-flight task so a crash costs a task rather
// than a session.
//
// The pieces it is built from are exported too, because they are separately
// useful and separately testable: the tool surface a worker exposes, the
// summary-index I/O those tools read, and the per-task permission maths.

export {
  spawnAgent,
  spawnAgentPool,
  type Agent,
  type SandboxReport,
  type SpawnAgentOptions,
} from './spawn.js'

export {
  createToolHandle,
  tokenizeCommand,
  type LaunchHandle,
  type ToolCache,
} from './tools.js'

// The native-addon wrapper. Re-exported so a consumer of the tool surface does
// not have to reach for the addon package directly to do the few things those
// tools do (scan a project, run a command with a deadline).
export {
  scanProject,
  runCommandAsync,
  runCommandAsyncTimeout,
  loadEnvFile,
  redact,
  isMaskedName,
  type EnvVar,
} from './native.js'

export {
  normalizeProjectPath,
  computeTaskPermissions,
  type TaskFilePermissions,
} from './task-permissions.js'

export {
  buildSummaryIndex,
  shouldSkipFile,
  formatSummaryIndexHierarchical,
  renderSummaryIndex,
  searchSummary,
  SKIP_DIRS,
  SKIP_EXTENSIONS,
  SKIP_SUFFIXES,
  type SummaryEntry,
} from './summary.js'
