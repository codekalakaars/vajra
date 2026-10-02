import { type PlannedTaskInput } from '@codekalakaars/vajra-protocol'
import { createToolHandle
} from '@codekalakaars/vajra-sandbox'
import { buildContextPack, packBudgetTokens } from '../worker/pack.js'
import type { WorkerParams } from './params.js'
import { setup } from './suite.js'

/** The C1 payload a command tool returns: `{ exitCode, signal, stdout, stderr }`. */
function exitCodeOf(payload: unknown): number | null {
  if (typeof payload !== 'string') return null
  try {
    const parsed = JSON.parse(payload) as { exitCode?: unknown }
    return typeof parsed.exitCode === 'number' ? parsed.exitCode : null
  } catch {
    return null
  }
}

/**
 * Run every verify command against the untouched fixture and record what it did.
 *
 * Measured, never asserted: `validatePlan` rejects a `proves-change` that
 * already passes, and a suite that claimed a baseline nobody observed would pass
 * that check for the wrong reason. A command the harness refuses (not on the
 * allow-list, cwd escape) is a suite that cannot prove anything, so it stops the
 * run rather than becoming a baseline of -1.
 */
export async function measureBaselines(
  projectDir: string,
  tasks: readonly PlannedTaskInput[],
): Promise<Map<string, number>> {
  const baselines = new Map<string, number>()
  const handle = createToolHandle(projectDir, { cache: { read: new Map(), generation: 0 } })
  for (const task of tasks) {
    for (const [index, verify] of (task.verify ?? []).entries()) {
      const args = { command: verify.command, args: verify.args ?? [] }
      let exitCode: number | null
      try {
        exitCode = exitCodeOf(await handle.callTool('run_baseline', args))
      } catch (err) {
        return setup(
          `Task '${task.id}' verify[${index}] (${verify.command}) could not be baselined: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (exitCode === null) {
        return setup(
          `Task '${task.id}' verify[${index}] (${verify.command} ${(verify.args ?? []).join(' ')}) ` +
            'returned no exit code, so it cannot prove anything.',
        )
      }
      if (exitCode < 0) {
        return setup(
          `Task '${task.id}' verify[${index}] (${verify.command}) was rejected by the harness ` +
            'rather than run. Use an allowed command with no shell syntax.',
        )
      }
      baselines.set(`${task.id}#${index}`, exitCode)
    }
  }
  return baselines
}

// --- the run ---------------------------------------------------------------

/**
 * Refuse a suite whose tasks cannot fit in a pack.
 *
 * A pack's fixed sections — the task, what done means, the anchors, the scope,
 * the contracts, the project card — are the parts the Worker cannot work
 * without, so nothing the runtime may cut can make them fit. When they do not
 * fit, every Worker for that task starts with a truncated brief and no warning,
 * which is a measurement of nothing. It is a setup error rather than a failed
 * run: the suite, not the arrangement, is wrong, and the fix is to split the
 * task or narrow what it declares.
 *
 * Checked here, before the pool is forked, against the fixture as it stands.
 * The packs the Workers actually get are built at dispatch, when dependencies
 * have finished, and may legitimately differ.
 */
export async function assertPacksFit(
  params: WorkerParams,
  tasks: readonly PlannedTaskInput[],
  projectDir: string,
): Promise<void> {
  const budget = packBudgetTokens(params, params.workerModel)
  // An in-process handle with no task scope: this asks how big the pack is, not
  // what a Worker may read, and a per-task scope would make the check depend on
  // which task happened to be measured.
  const handle = createToolHandle(projectDir, { cache: { read: new Map(), generation: 0 } })
  const text = (result: unknown): string =>
    typeof result === 'string' ? result : JSON.stringify(result ?? '')
  for (const task of tasks) {
    const pack = await buildContextPack({
      task,
      params,
      model: params.workerModel,
      read: async (path, symbols) =>
        text(await handle.callTool('read_file', symbols && symbols.length > 0 ? { path, symbols } : { path })),
      list: async path => text(await handle.callTool('list_files', { path })),
    })
    const fixed = pack.sections
      .filter(section => section.fixed)
      .reduce((sum, section) => sum + section.tokens, 0)
    if (fixed > budget) {
      setup(
        `task '${task.id}' needs about ${fixed} tokens of context it cannot do without, over the ` +
          `${budget}-token pack budget (packWindowShare ${params.packWindowShare} of the ` +
          `${params.workerModel} window): split this task or narrow its context`,
      )
    }
  }
}
