import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { validatePlan, type PlanEvidence, type PlannedTaskInput } from '@codekalakaars/vajra-protocol'
import { createToolHandle, spawnAgentPool, type Agent } from '@codekalakaars/vajra-agent-process'
import { Command } from 'commander'
import { parseProposePlanArgs } from '../agent/developer.js'
import { buildContextPack, packBudgetTokens } from '../agent/pack.js'
import { executePlan } from '../session/service.js'
import type { AgentEvent, SessionUI, TaskEvent } from '../session/ui.js'
import { storedOpenCodeKey } from '../auth.js'
import { loadWorkerParams, WorkerParamsError } from '../config.js'
import { createBenchRecorder, type BenchRecorder } from './metrics.js'
import type { BenchResult } from './result.js'
import type { WorkerParams } from './params.js'

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

/** How a suite's acceptance tests are run, after the run has finished. */
export interface BenchAcceptance {
  /** Executable, resolved against PATH. No shell: argv only. */
  command: string
  args?: string[]
  timeoutMs?: number
}

/** `plan.json`: the plan, plus how to check the run's result. */
export interface BenchSuitePlan {
  summary?: string
  acceptance: BenchAcceptance
  tasks: PlannedTaskInput[]
}

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

/** A setup error: the run never started, so it is exit 2 and not a failed run. */
class BenchSetupError extends Error {}

function setup(message: string): never {
  throw new BenchSetupError(message)
}

// --- the suite on disk -----------------------------------------------------

function readJson(file: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return setup(
      code === 'ENOENT'
        ? `${what} is missing: ${file}`
        : `${what} cannot be read: ${file} (${code ?? 'unknown error'})`,
    )
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    return setup(`${what} is not valid JSON: ${file} (${err instanceof Error ? err.message : String(err)})`)
  }
}

function parseAcceptance(raw: unknown, file: string): BenchAcceptance {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return setup(`${file}: 'acceptance' is required, as { "command": "node", "args": ["--test"] }`)
  }
  const value = raw as Record<string, unknown>
  const command = value.command
  if (typeof command !== 'string' || !command.trim()) {
    return setup(`${file}: 'acceptance.command' is required and must be a non-empty string`)
  }
  const args = value.args ?? []
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    return setup(`${file}: 'acceptance.args' must be an array of strings`)
  }
  const timeoutMs = value.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return setup(`${file}: 'acceptance.timeoutMs' must be a positive number of milliseconds`)
  }
  return {
    command: command.trim(),
    args: args as string[],
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  }
}

function parseSuitePlan(file: string): BenchSuitePlan {
  const raw = readJson(file, 'plan.json') as Record<string, unknown>
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    return setup(`${file}: 'tasks' is required and must be a non-empty array`)
  }
  return {
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    acceptance: parseAcceptance(raw.acceptance, file),
    tasks: raw.tasks as PlannedTaskInput[],
  }
}

// --- evidence --------------------------------------------------------------

/** Never worth walking, and never worth validating an edit against. */
const SKIP_DIRS = new Set(['node_modules', '.git'])

function projectRelative(projectDir: string, path: string): string {
  return path.slice(projectDir.length + 1).split(sep).join('/')
}

/**
 * What the plan may claim to know: every file in the working copy, with its
 * content.
 *
 * A suite's plan is written by hand, so nothing has been read by a Developer
 * turn. Reading the fixture here is what makes `validatePlan` mean something —
 * an edit with an anchor that does not appear in the file is still an error.
 */
function readFixture(projectDir: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const full = join(dir, entry.name)
      try {
        files.set(projectRelative(projectDir, full), readFileSync(full, 'utf-8'))
      } catch {
        // Not text, or unreadable: the plan cannot anchor against it either.
      }
    }
  }
  walk(projectDir)
  return files
}

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
async function measureBaselines(
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
async function assertPacksFit(
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

/**
 * A UI that measures instead of drawing.
 *
 * Every event goes to the recorder — the recorder *is* the measurement, read off
 * the same stream the CLI renderer prints, so a score cannot describe a different
 * run than the one it came from. Output is a line per task unless `verbose`.
 */
function benchUi(recorder: BenchRecorder, options: BenchOptions): SessionUI {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const describe = (event: TaskEvent): string => {
    switch (event.type) {
      case 'start':
        return `  [${event.index}/${event.total}] ${event.title}`
      case 'done':
        return `  done: ${event.title}`
      case 'failed':
        return `  FAILED: ${event.title}`
      case 'skipped':
        return `  skipped: ${event.title}`
      case 'retry':
        return `  retry ${event.attempt}/${event.max}: ${event.title}`
      case 'no-changes':
        return `  no changes: ${event.title}`
    }
  }
  const noPrompt = async (what: string): Promise<never> => {
    throw new Error(`A bench run takes no input, but something asked for ${what}`)
  }
  return {
    banner: () => {},
    info: message => write(message),
    success: message => write(message),
    error: message => write(`error: ${message}`),
    warning: message => write(`warning: ${message}`),
    newline: () => {},
    restoredTurn: () => {},
    onTextDelta: text => {
      if (options.verbose) write(text)
    },
    onThinkingDelta: text => {
      if (options.verbose) write(`thinking: ${text}`)
    },
    finishLine: () => {},
    discardBuffer: () => {},
    askInitialTask: () => noPrompt('an initial task'),
    askUserMessage: () => noPrompt('a message'),
    showPlan: () => {},
    askConfirmPlan: () => noPrompt('plan confirmation'),
    askRejectFeedback: () => noPrompt('rejection feedback'),
    onTaskEvent: event => {
      recorder.taskEvent(event)
      write(describe(event))
    },
    onAgentEvent: event => {
      recorder.agentEvent(event)
      if (!options.verbose) return
      if (event.type === 'tool-start') {
        write(`    ${event.agent.taskId ?? event.agent.role} → ${event.tool} ${event.summary}`)
      } else if (event.type === 'tool-end') {
        write(`    ${event.agent.taskId ?? event.agent.role} ← ${event.tool} ${event.detail ?? ''}`)
      }
    },
  }
}

/**
 * Copy a suite's acceptance tests in and run them against the finished tree.
 *
 * Copied as a directory, not flattened: a suite's tests belong together and must
 * not collide with a file the plan created.
 */
function runAcceptance(
  acceptance: BenchAcceptance,
  suiteDir: string,
  projectDir: string,
): Promise<{ exitCode: number; output: string }> {
  const acceptDir = join(suiteDir, 'accept')
  if (!existsSync(acceptDir) || !statSync(acceptDir).isDirectory()) {
    return Promise.reject(new BenchSetupError(`accept/ is missing: ${acceptDir}`))
  }
  cpSync(acceptDir, join(projectDir, 'accept'), { recursive: true })

  return new Promise(resolvePromise => {
    // A spawned acceptance command is its own program. `NODE_TEST_CONTEXT`
    // belongs to whatever test runner started *us*, and a child that inherits it
    // refuses to run its files — which would make a suite's result depend on how
    // the bench was invoked.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
    delete env.NODE_TEST_CONTEXT
    delete env.NODE_TEST_WORKER_ID

    const child = spawn(acceptance.command, acceptance.args ?? [], {
      cwd: projectDir,
      // No shell: an acceptance command is argv, and a suite that needs shell
      // syntax is a suite whose result depends on the shell it happened to run in.
      // A glob is the shell's job too, so name the test files outright.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    const chunks: string[] = []
    const collect = (data: Buffer): void => {
      // Enough to explain a failure, not enough to fill a result file.
      if (chunks.join('').length < 8000) chunks.push(data.toString('utf-8'))
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, acceptance.timeoutMs ?? 120_000)
    timer.unref?.()

    child.on('error', err => {
      clearTimeout(timer)
      resolvePromise({ exitCode: 127, output: `${chunks.join('')}\n${err.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({
        exitCode: timedOut ? 124 : (code ?? 1),
        output: chunks.join(''),
      })
    })
  })
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
      {
        model: params.workerModel,
        apiKey,
        projectDir,
        autoConfirm: true,
        timeout: params.taskTimeoutSec,
      },
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
