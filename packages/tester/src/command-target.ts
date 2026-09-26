// A runner that executes an existing test suite and reads its report.
//
// Mechanism B's second half. The generators emit a test file in the project's
// own idiom; this runs it and hands the report to the existing JUnit ingestion.
// Nothing here knows what was tested, which is the point — the project's own
// framework already does.

import { createCommandRunner, type CommandRunnerOptions } from './command.js'
import type { RawRunResult, RunRequest, RunnerAdapter } from './runner.js'
import { parseJunit } from './formats/junit.js'
import { parseTap } from './formats/tap.js'
import { parseAuto } from './formats/index.js'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

export type CommandReportTarget = CommandRunnerOptions & {
  /** Parse a JUnit report written to this path rather than stdout. */
  junitPath?: string
  /** Parse a TAP report written to this path. */
  tapPath?: string
}

/**
 * Runs a project's own test command and ingests its report.
 *
 * A non-zero exit with a parseable report is not an error: a failing suite is
 * the ordinary case and its per-test results are the answer. Only an *unparseable*
 * report is an environment failure, because then nothing is known about the run.
 */
export function createJestLikeRunner(options: CommandReportTarget): RunnerAdapter {
  const base = createCommandRunner(
    {
      ...options,
      report: options.report ?? { format: 'junit' },
      reportPath: options.junitPath ?? options.tapPath ?? options.reportPath,
    },
    { exec: execCapture },
  )

  return {
    name: options.command[0] ?? 'suite',
    version: options.version ?? '1',
    async run(request: RunRequest): Promise<RawRunResult> {
      const result = await base.run(request)
      if (result.tests.length === 1 && result.tests[0].ref === 'report') {
        // The command ran but produced nothing parseable. Try the other format
        // before giving up, since a project may emit either.
        const recovered = await readAlternateReport(options)
        if (recovered) return recovered
      }
      return result
    },
  }
}

async function readAlternateReport(
  options: CommandReportTarget,
): Promise<RawRunResult | null> {
  const path = options.junitPath ?? options.tapPath ?? options.reportPath
  if (!path) return null
  try {
    const text = await readFile(path, 'utf8')
    return options.tapPath ? parseTap(text) : parseAuto(text)
  } catch {
    return null
  }
}

async function execCapture(
  argv: readonly string[],
  options: CommandRunnerOptions,
): Promise<{ stdout: string; code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout?.on('data', (c) => {
      stdout += String(c)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ stdout, code, signal })
    })
  })
}
