import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import { spawnAgentPool, type Agent } from '@codekalakaars/vajra-sandbox'
import { Command } from 'commander'
import { loadWorkerParams, WorkerParamsError } from '../bench/config.js'
import { planWithDeveloper, type PlanningPerson } from '../developer/conversation.js'
import { executePlan } from '../manager/execute-plan.js'
import { storedOpenCodeKey } from '../model/auth.js'
import { consoleUi } from './console-ui.js'

/** The Developer's model. Not part of the arrangement: it plans, it does not run tasks. */
export const DEFAULT_DEVELOPER_MODEL = 'zen/space-bunny-free'

export const RUN_EXIT_OK = 0
export const RUN_EXIT_FAILED = 1
export const RUN_EXIT_SETUP = 2
/** The person stopped, or the Developer never settled on a plan: nothing ran. */
export const RUN_EXIT_NO_PLAN = 3

export interface RunOptions {
  /** What the person wants done. */
  task: string
  projectDir: string
  /** The arrangement for the Workers. Defaults to the repository's `bench/config.json`. */
  configPath?: string
  developerModel?: string
  /** Accept the Developer's plan without asking. */
  yes?: boolean
  allowUnenforced?: boolean
  /** Who answers the Developer. Defaults to the terminal. */
  person?: PlanningPerson
  write?: (line: string) => void
  writeText?: (text: string) => void
  signal?: AbortSignal
}

/** The repository's own arrangement, found relative to this file (dist/cli/run.js). */
function defaultConfigPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'bench', 'config.json')
}

/** A person at the terminal. Without a terminal there is no one to ask, so they stop. */
function terminalPerson(write: (line: string) => void): PlanningPerson {
  const interactive = Boolean(process.stdin.isTTY)
  const ask = async (prompt: string): Promise<string | null> => {
    if (!interactive) {
      write('No terminal to ask on; stopping. Run from a terminal, or pass --yes to accept the plan.')
      return null
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await rl.question(prompt)).trim()
      return answer === '' || /^(exit|quit)$/i.test(answer) ? null : answer
    } finally {
      rl.close()
    }
  }
  return {
    answer: async () => ask('\n> '),
    review: async plan => {
      showPlan(plan, write)
      const reply = await ask('\nRun this plan? [y]es, or say what to change, or press enter to stop\n> ')
      if (reply === null) return null
      return /^y(es)?$/i.test(reply) ? true : reply
    },
  }
}

function showPlan(plan: DeveloperPlan, write: (line: string) => void): void {
  write('')
  write(`Plan: ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}`)
  for (const task of plan.tasks) {
    const after = task.dependsOn.length > 0 ? `  (after ${task.dependsOn.join(', ')})` : ''
    write(`  ${task.id}: ${task.title}${after}`)
    for (const file of task.writeFile) write(`      writes ${file}`)
  }
}

/**
 * Plan with the Developer, then run the plan with the Manager.
 *
 * The Developer reads the project through the same confined worker the Workers
 * use, so what it can see is what a Worker could read. Returns the process exit
 * code; nothing here throws, because a failure is a code and a line.
 */
export async function runTask(options: RunOptions): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const writeText = options.writeText ?? ((text: string) => process.stdout.write(text))
  const ui = consoleUi({ write, writeText })
  const projectDir = resolve(options.projectDir)
  let sandbox: Agent | null = null

  try {
    if (!existsSync(projectDir)) {
      write(`error: project directory does not exist: ${projectDir}`)
      return RUN_EXIT_SETUP
    }
    // Only the credential comes from the environment; the arrangement does not.
    const apiKey = process.env.OPENCODE_API_KEY?.trim() || storedOpenCodeKey(process.env)
    if (!apiKey) {
      write('error: no API key: set OPENCODE_API_KEY, or run `vajra auth login <key>`')
      return RUN_EXIT_SETUP
    }
    const configPath = options.configPath ?? defaultConfigPath()
    let params
    try {
      params = loadWorkerParams(configPath)
    } catch (err) {
      if (!(err instanceof WorkerParamsError)) throw err
      write(`error: ${err.message}`)
      return RUN_EXIT_SETUP
    }

    const sessionId = randomUUID()
    const allowUnenforced = options.allowUnenforced ?? false
    try {
      sandbox = await spawnAgentPool(projectDir, sessionId, {
        allowUnenforced,
        requireEnforced: !allowUnenforced,
        maxWorkers: Number.POSITIVE_INFINITY,
        maxIdleWorkers: params.warmSandboxes,
        onWorkerOutput: line => write(`    worker: ${line}`),
      })
    } catch (err) {
      write(
        `error: the sandbox could not start: ${err instanceof Error ? err.message : String(err)}` +
          (allowUnenforced ? '' : ' (pass --allow-unenforced on a kernel without Landlock)'),
      )
      return RUN_EXIT_SETUP
    }
    if (!sandbox.report.enforced) {
      write(`warning: sandbox not enforced (${sandbox.report.mechanism}); tools run with app-level permissions only`)
    }

    const person: PlanningPerson = options.person ?? (options.yes
      ? {
          // Nobody is there to answer, so a reply that is not a plan is a pause, not an
          // end: nudge it on. The turn limit is what stops one that never settles.
          answer: async () => 'Continue. If you have what you need, call propose_plan now.',
          review: async plan => (showPlan(plan, write), true),
        }
      : terminalPerson(write))

    const outcome = await planWithDeveloper({
      projectDir,
      apiKey,
      model: options.developerModel ?? DEFAULT_DEVELOPER_MODEL,
      task: options.task,
      handle: sandbox.handle,
      person,
      ...(options.signal ? { signal: options.signal } : {}),
      onTextDelta: text => ui.onTextDelta(text),
      onAgentEvent: event => ui.onAgentEvent(event),
    })
    ui.finishLine()
    if (outcome.type === 'stopped') {
      write(
        outcome.reason === 'turns'
          ? 'The Developer did not settle on a plan. Nothing was run.'
          : 'Stopped. Nothing was run.',
      )
      return RUN_EXIT_NO_PLAN
    }

    write('\nRunning the plan...\n')
    const execution = await executePlan(
      outcome.plan,
      params,
      { apiKey, projectDir, timeout: params.taskTimeoutSec, ...(options.signal ? { signal: options.signal } : {}) },
      ui,
      { sandbox, sessionId },
    )
    return execution.exitCode === 0 ? RUN_EXIT_OK : RUN_EXIT_FAILED
  } finally {
    sandbox?.close()
  }
}

export function runCommand(): Command {
  return new Command('run')
    .description('Describe what you want done: the Developer plans it, the Manager runs the plan on Workers')
    .argument('<task...>', 'What you want done, in words')
    .option('-d, --dir <dir>', 'The project to work in', '.')
    .option('--config <file>', "The Workers' arrangement (default: the repository's bench/config.json)")
    .option('--model <id>', "The Developer's model", DEFAULT_DEVELOPER_MODEL)
    .option('-y, --yes', "Accept the Developer's plan without asking")
    .option('--allow-unenforced', 'Run without kernel enforcement on a kernel without Landlock')
    .addHelpText(
      'after',
      `
Exit codes:
  0  the plan ran and every task completed
  1  the plan ran and something failed
  2  setup error: no API key, bad config, the sandbox could not start
  3  nothing ran: you stopped, or the Developer never settled on a plan
`,
    )
    .action(async (task: string[], options: { dir: string; config?: string; model: string; yes?: boolean; allowUnenforced?: boolean }) => {
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      process.exitCode = await runTask({
        task: task.join(' '),
        projectDir: options.dir,
        ...(options.config ? { configPath: resolve(options.config) } : {}),
        developerModel: options.model,
        yes: Boolean(options.yes),
        allowUnenforced: Boolean(options.allowUnenforced),
        signal: controller.signal,
      })
    })
}
