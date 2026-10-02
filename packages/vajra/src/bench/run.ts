import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { validatePlan, type PlanEvidence } from '@codekalakaars/vajra-protocol'
import { spawnAgentPool, type Agent } from '@codekalakaars/vajra-sandbox'
import { Command } from 'commander'
import { parseProposePlanArgs } from '../developer/plan.js'
import { executePlan } from '../manager/execute-plan.js'
import { storedOpenCodeKey } from '../model/auth.js'
import { loadWorkerParams, WorkerParamsError } from './config.js'
import { createBenchRecorder } from './metrics.js'
import type { BenchResult } from './result.js'
import type { WorkerParams } from './params.js'
import { assertPacksFit, measureBaselines } from './checks.js'
import { BenchSetupError, BenchSuitePlan, parseSuitePlan, readFixture, setup } from './suite.js'
import { benchUi } from './bench-ui.js'
import { runAcceptance } from './acceptance.js'

/**
 * One `vajra bench <suite>`: a predefined plan, a fresh copy of the suite's
 * files, the arrangement in `bench/config.json`, and the suite's own acceptance
 * command afterwards.
 *
 * There is no Developer and no human: the plan is read off disk, the run takes
 * no input, and the only thing that decides the exit code is whether every task
 * completed and the acceptance command passed.
 *
 * Workers run in the same sandbox pool a session uses, with no cap on its size
 * and `warmSandboxes` kept warm. Forking a confined worker is part of what a
 * real run costs, and it is what `warmSandboxes` trades against memory, so a
 * bench that skipped it would score an arrangement nobody runs. What is
 * deliberately not here is a persisted session: ten repetitions per suite must
 * not leave ten records behind.
 */

export const BENCH_EXIT_OK = 0
/** The run happened and failed: tasks did not complete, or acceptance did not pass. */
export const BENCH_EXIT_FAILED = 1
/** The run never started: bad config, invalid plan, missing suite files. */
export const BENCH_EXIT_SETUP = 2

export interface BenchOptions {
  suiteDir: string
  /** Defaults to `bench/config.json` under the working directory. */
  configPath?: string
  /** Where the BenchResult is written. */
  out?: string
  /** Leave the working copy behind, to look at after a failure. */
  keepProject?: boolean
  /** Print each Worker round and tool call. */
  verbose?: boolean
  /**
   * Run Workers without kernel enforcement when the kernel cannot provide it.
   * A security choice, not part of the arrangement: it changes no timing a
   * sweep compares, because every run on one machine makes the same choice.
   */
  allowUnenforced?: boolean
  /** Injected by the tests; defaults to writing a line. */
  write?: (line: string) => void
  /** Where a setup error goes. Defaults to stderr. */
  writeError?: (line: string) => void
}

// --- the command -----------------------------------------------------------

function defaultConfigPath(): string {
  return resolve(process.cwd(), 'bench', 'config.json')
}

function writeResult(path: string, result: BenchResult): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')
}

function defaultResultPath(suite: string): string {
  return resolve(process.cwd(), 'bench', 'results', `${suite}-${Date.now()}.json`)
}

/**
 * Run one suite once, and return the process exit code.
 *
 * Nothing here throws: every failure becomes a code and a line, because a sweep
 * runs this hundreds of times and one thrown error would end the sweep instead
 * of recording a run that failed.
 */
export async function runBench(options: BenchOptions): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`))
  const suiteDir = resolve(options.suiteDir)
  const suite = suiteDir.split(sep).pop() ?? suiteDir

  let params: WorkerParams
  try {
    params = loadWorkerParams(options.configPath ?? defaultConfigPath())
  } catch (err) {
    if (err instanceof WorkerParamsError) {
      writeError(`bench ${suite}: ${err.message}`)
      return BENCH_EXIT_SETUP
    }
    throw err
  }

  interface Prepared {
    suitePlan: BenchSuitePlan
    planFile: string
    fixtureDir: string
    apiKey: string
  }

  let prepared: Prepared
  try {
    if (!existsSync(suiteDir) || !statSync(suiteDir).isDirectory()) {
      setup(`no such suite directory: ${suiteDir}`)
    }
    const planFile = join(suiteDir, 'plan.json')
    const fixtureDir = join(suiteDir, 'fixture')
    const acceptDir = join(suiteDir, 'accept')
    if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) {
      setup(`suite is missing fixture/: ${fixtureDir}`)
    }
    if (!existsSync(acceptDir) || !statSync(acceptDir).isDirectory()) {
      setup(`suite is missing accept/: ${acceptDir}`)
    }
    const suitePlan = parseSuitePlan(planFile)
    // Only the credential comes from the environment; the arrangement does not.
    const apiKey = process.env.OPENCODE_API_KEY?.trim() || storedOpenCodeKey(process.env)
    if (!apiKey) {
      setup('no API key: set OPENCODE_API_KEY, or run `vajra auth login <key>`')
    }
    prepared = { suitePlan, planFile, fixtureDir, apiKey }
  } catch (err) {
    if (!(err instanceof BenchSetupError)) throw err
    writeError(`bench ${suite}: ${err.message}`)
    return BENCH_EXIT_SETUP
  }

  const { suitePlan, planFile, fixtureDir, apiKey } = prepared

  // A fresh copy of the suite's files, every time: the fixture is the baseline
  // the run starts from, and a second run against a mutated tree would be
  // measuring the first run's leftovers.
  const projectDir = mkdtempSync(join(tmpdir(), 'vajra-bench-'))
  const sessionId = randomUUID()
  let sandbox: Agent | null = null

  try {
    cpSync(fixtureDir, projectDir, { recursive: true })

    const parsed = parseProposePlanArgs(
      { tasks: suitePlan.tasks, summary: suitePlan.summary ?? suite },
      projectDir,
    )
    if (!parsed.ok) setup(`${planFile}: ${parsed.error}`)

    const evidence: PlanEvidence = {
      filesRead: readFixture(projectDir),
      baselines: await measureBaselines(projectDir, parsed.plan.tasks),
    }
    const validation = validatePlan(parsed.plan.tasks, evidence, projectDir)
    if (!validation.ok) {
      setup(`${planFile} is not a runnable plan:\n- ${validation.errors.join('\n- ')}`)
    }

    if (params.contextPack) await assertPacksFit(params, parsed.plan.tasks, projectDir)

    const recorder = createBenchRecorder({
      suite,
      config: params,
      tasks: parsed.plan.tasks,
    })

    // Spawned after validation, so a suite that cannot run never forks, and
    // before the recorder sees an event, so the primary's start-up is not on
    // the clock. Pooled workers are forked during the run, and that is.
    const allowUnenforced = options.allowUnenforced ?? false
    try {
      sandbox = await spawnAgentPool(projectDir, sessionId, {
        allowUnenforced,
        requireEnforced: !allowUnenforced,
        // No cap: the scheduler admits Workers while CPU and RAM have room.
        maxWorkers: Number.POSITIVE_INFINITY,
        maxIdleWorkers: params.warmSandboxes,
        onWorkerOutput: line => {
          if (options.verbose) write(`    worker: ${line}`)
        },
      })
    } catch (err) {
      setup(
        `the sandbox could not start: ${err instanceof Error ? err.message : String(err)}` +
          (allowUnenforced ? '' : ' (pass --allow-unenforced on a kernel without Landlock)'),
      )
    }

    const execution = await executePlan(
      parsed.plan,
      params,
      { apiKey, projectDir, timeout: params.taskTimeoutSec },
      benchUi(recorder, { ...options, write }),
      { sandbox, sessionId },
    )
    sandbox?.close()
    sandbox = null

    const acceptance = await runAcceptance(suitePlan.acceptance, suiteDir, projectDir)
    if (acceptance.output.trim()) {
      write(acceptance.output.trimEnd())
    }

    // A run succeeds when every task completed *and* the suite's own tests
    // pass. Either half failing is a failed run, and both are reported.
    const unfinished = execution.tasks.filter(
      t => t.status !== 'done' && t.status !== 'skipped',
    )
    const reasons: string[] = []
    if (unfinished.length > 0) {
      reasons.push(
        `${unfinished.length} task(s) did not complete: ` +
          unfinished.map(t => `${t.id} [${t.status}]`).join(', '),
      )
    }
    if (execution.aborted) {
      reasons.push(`the Manager stopped the plan: ${execution.abortedReason ?? 'aborted'}`)
    }
    if (acceptance.exitCode !== 0) {
      reasons.push(`acceptance command failed (exit ${acceptance.exitCode})`)
    }
    const success = reasons.length === 0

    write(
      success
        ? `bench ${suite}: ok — ${execution.report.lines.join('  ')}`
        : `bench ${suite}: FAILED — ${reasons.join('; ')}`,
    )

    const result: BenchResult = recorder.result({
      success,
      ...(success ? {} : { failureReason: reasons.join('; ') }),
    })
    const outPath = options.out ?? defaultResultPath(suite)
    try {
      writeResult(outPath, result)
    } catch (err) {
      writeError(
        `bench ${suite}: result not written to ${outPath} (${
          err instanceof Error ? err.message : String(err)
        })`,
      )
      return BENCH_EXIT_FAILED
    }
    write(`result: ${outPath}`)
    return success ? BENCH_EXIT_OK : BENCH_EXIT_FAILED
  } catch (err) {
    if (err instanceof BenchSetupError) {
      writeError(`bench ${suite}: ${err.message}`)
      return BENCH_EXIT_SETUP
    }
    writeError(
      `bench ${suite}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    )
    return BENCH_EXIT_FAILED
  } finally {
    sandbox?.close()
    if (options.keepProject) {
      write(`working copy kept at ${projectDir}`)
    } else {
      rmSync(projectDir, { recursive: true, force: true })
    }
  }
}

/** `vajra bench <suite-dir> [--config <file>] [--out <result.json>]` */
export function benchCommand(): Command {
  return new Command('bench')
    .description('Run a task suite once, against the arrangement in bench/config.json')
    .argument('<suite-dir>', 'Suite directory: fixture/, plan.json, accept/')
    .option('--config <file>', 'Arrangement to run with', 'bench/config.json')
    .option('--out <file>', 'Where to write the BenchResult')
    .option('--keep', 'Leave the working copy behind, to look at after a failure')
    .option('-v, --verbose', 'Print each Worker round and tool call')
    .option('--allow-unenforced', 'Run Workers without kernel enforcement on a kernel without Landlock')
    .addHelpText(
      'after',
      `
Exit codes:
  0  every task completed and the acceptance command passed
  1  the run failed
  2  setup error: bad config, invalid plan, missing suite files

A run reads the arrangement from one file and nowhere else: no VAJRA_* variable,
no ~/.vajra/config.json, no flag. Only the API key comes from the environment.

A suite is fixture/, plan.json and accept/. plan.json carries the plan and the
acceptance command as argv — { "command": "node", "args": ["--test",
"accept/accept.test.mjs"] } — with no shell, so a glob is not expanded: name the
test files. The tests are copied in after the run, from the finished tree.
      `,
    )
    .action(async (suiteDir: string, options: { config?: string; out?: string; keep?: boolean; verbose?: boolean; allowUnenforced?: boolean }) => {
      process.exitCode = await runBench({
        suiteDir,
        ...(options.config ? { configPath: resolve(options.config) } : {}),
        ...(options.out ? { out: resolve(options.out) } : {}),
        keepProject: Boolean(options.keep),
        verbose: Boolean(options.verbose),
        allowUnenforced: Boolean(options.allowUnenforced),
      })
    })
}
