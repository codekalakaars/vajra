import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import { spawnAgentPool, type Agent } from '@codekalakaars/vajra-sandbox'
import { Command } from 'commander'
import { DEFAULT_DEVELOPER_MODEL } from '../cli/run.js'
import { planWithDeveloper, type PlanningPerson } from '../developer/conversation.js'
import { storedOpenCodeKey } from '../model/auth.js'
import { createPlanLog } from './plan-log.js'
import { checkPlan, parseExpectation, type PlanCheck } from './plan-checks.js'

/** How often a silent run is checked on; `createPlanLog` decides whether it has been quiet long enough to say so. */
const QUIET_CHECK_MS = 10_000

/** A reply or request on one line, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const PLAN_BENCH_EXIT_OK = 0
export const PLAN_BENCH_EXIT_FAILED = 1
export const PLAN_BENCH_EXIT_SETUP = 2

/** What one `vajra bench-plan` run writes to `--out`. */
export interface PlanBenchResult {
  case: string
  model: string
  /** The Developer settled on a plan and every check passed. */
  success: boolean
  failureReason?: string
  wallMs: number
  /** Times the Developer stopped to ask instead of planning. */
  questions: number
  /** The checkpoint log of the run, under the case's `runs/`. */
  log: string
  checks: PlanCheck[]
  plan?: DeveloperPlan
}

export interface PlanBenchOptions {
  caseDir: string
  developerModel?: string
  out?: string
  allowUnenforced?: boolean
  write?: (line: string) => void
}

/**
 * Plan one case with the Developer, on a copy of the case's fixture, and judge
 * the plan. No Worker runs: this measures the Developer alone, so a change to its
 * prompt or context can be compared without paying for the Workers too.
 *
 * Nobody is there to answer, so a reply that is not a plan is counted as a
 * question and nudged on; the checks decide whether asking was acceptable.
 */
export async function runPlanBench(options: PlanBenchOptions): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const caseDir = resolve(options.caseDir)
  const name = caseDir.split('/').pop() ?? caseDir
  const model = options.developerModel ?? DEFAULT_DEVELOPER_MODEL
  let workDir: string | null = null
  let sandbox: Agent | null = null
  let quietTimer: NodeJS.Timeout | null = null

  try {
    for (const required of ['request.txt', 'expect.json', 'fixture']) {
      if (!existsSync(join(caseDir, required))) {
        write(`plan bench ${name}: missing ${required} in ${caseDir}`)
        return PLAN_BENCH_EXIT_SETUP
      }
    }
    let expectation
    try {
      expectation = parseExpectation(JSON.parse(readFileSync(join(caseDir, 'expect.json'), 'utf-8')), `${name}/expect.json`)
    } catch (err) {
      write(`plan bench ${name}: ${err instanceof Error ? err.message : String(err)}`)
      return PLAN_BENCH_EXIT_SETUP
    }
    const apiKey = process.env.OPENCODE_API_KEY?.trim() || storedOpenCodeKey(process.env)
    if (!apiKey) {
      write('error: no API key: set OPENCODE_API_KEY, or run `vajra auth login <key>`')
      return PLAN_BENCH_EXIT_SETUP
    }

    workDir = mkdtempSync(join(tmpdir(), 'vajra-plan-bench-'))
    cpSync(join(caseDir, 'fixture'), workDir, { recursive: true })
    const log = createPlanLog({ caseDir, stamp: new Date().toISOString().replace(/[:.]/g, '-'), write })
    log.note(`case ${name}, model ${model}`)
    log.note(`request: ${oneLine(readFileSync(join(caseDir, 'request.txt'), 'utf-8'), 200)}`)
    log.note(`planning in ${workDir} (a copy of the fixture; the case itself is not touched)`)
    log.note(`log: ${log.path}`)
    quietTimer = setInterval(() => log.quiet(), QUIET_CHECK_MS)
    quietTimer.unref()
    const allowUnenforced = options.allowUnenforced ?? false
    try {
      sandbox = await spawnAgentPool(workDir, randomUUID(), {
        allowUnenforced,
        requireEnforced: !allowUnenforced,
        maxWorkers: 1,
        maxIdleWorkers: 1,
      })
    } catch (err) {
      write(
        `error: the sandbox could not start: ${err instanceof Error ? err.message : String(err)}` +
          (allowUnenforced ? '' : ' (pass --allow-unenforced on a kernel without Landlock)'),
      )
      return PLAN_BENCH_EXIT_SETUP
    }

    log.note('sandbox started')
    let questions = 0
    const person: PlanningPerson = {
      answer: async response => {
        questions++
        log.note(`the Developer asked (question ${questions}): ${oneLine(response, 300)}`)
        return 'Use your best judgment. If you have what you need, call propose_plan now.'
      },
      review: async plan => {
        log.note(`plan proposed: ${plan.tasks.length} tasks (${plan.tasks.map(task => task.id).join(', ')})`)
        return true
      },
    }
    const started = Date.now()
    const outcome = await planWithDeveloper({
      projectDir: workDir,
      apiKey,
      model,
      task: readFileSync(join(caseDir, 'request.txt'), 'utf-8').trim(),
      handle: sandbox.handle,
      person,
      onAgentEvent: event => log.event(event),
    })
    const wallMs = Date.now() - started

    const result: PlanBenchResult =
      outcome.type === 'plan'
        ? (() => {
            const checks = checkPlan(outcome.plan, expectation, { questions, projectDir: workDir as string })
            const failed = checks.filter(check => !check.ok)
            return {
              case: name,
              model,
              log: log.path,
              success: failed.length === 0,
              ...(failed.length > 0 ? { failureReason: `failed: ${failed.map(check => check.name).join(', ')}` } : {}),
              wallMs,
              questions,
              checks,
              plan: outcome.plan,
            }
          })()
        : {
            case: name,
            model,
            log: log.path,
            success: false,
            failureReason: `no plan (${outcome.reason})`,
            wallMs,
            questions,
            checks: [],
          }

    for (const check of result.checks) log.note(`check ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? `  ${check.detail}` : ''}`)
    log.note(`${result.success ? 'passed' : (result.failureReason ?? 'failed')} in ${(wallMs / 1000).toFixed(1)}s, ${questions} question${questions === 1 ? '' : 's'}`)
    const outPath = options.out ?? resolve(process.cwd(), 'bench', 'results', `plan-${name}-${Date.now()}.json`)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')
    log.note(`result: ${outPath}`)
    return result.success ? PLAN_BENCH_EXIT_OK : PLAN_BENCH_EXIT_FAILED
  } finally {
    if (quietTimer) clearInterval(quietTimer)
    sandbox?.close()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  }
}

/** `vajra bench-plan <case-dir> [--model <id>] [--out <result.json>]` */
export function planBenchCommand(): Command {
  return new Command('bench-plan')
    .description("Have the Developer plan one case from bench/developer/, and check the plan. Calls a real model; no Worker runs")
    .argument('<case-dir>', 'Case directory: request.txt, fixture/, expect.json')
    .option('--model <id>', "The Developer's model", DEFAULT_DEVELOPER_MODEL)
    .option('--out <file>', 'Where to write the PlanBenchResult')
    .option('--allow-unenforced', 'Run without kernel enforcement on a kernel without Landlock')
    .addHelpText(
      'after',
      `
Exit codes:
  0  the Developer settled on a plan and every check passed
  1  no plan, or a check failed
  2  setup error: missing case files, bad expect.json, no API key, no sandbox
`,
    )
    .action(async (caseDir: string, options: { model: string; out?: string; allowUnenforced?: boolean }) => {
      process.exitCode = await runPlanBench({
        caseDir,
        developerModel: options.model,
        ...(options.out ? { out: resolve(options.out) } : {}),
        allowUnenforced: Boolean(options.allowUnenforced),
      })
    })
}
