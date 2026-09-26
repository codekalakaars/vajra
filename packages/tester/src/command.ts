// A runner that executes an external command and reads a report file.
//
// This is what makes "any language" work in practice. Vajra does not need to
// know how Rust, Go, Python or Java tests are built and run — it needs to know
// how to invoke a command, give it a directory, wait, and read the report it
// produced. Everything language-specific lives in that command.

import type { RawRunResult, RunRequest, RunnerAdapter } from './runner.js'
import { parseAuto, type ParseOptions } from './formats/index.js'
import { parseJunit } from './formats/junit.js'
import { parseTap } from './formats/tap.js'

export interface CommandRunnerOptions {
  /** Executable and leading arguments. The test refs are appended. */
  command: readonly string[]
  cwd?: string
  /** How the report is produced. Omit to sniff the report format. */
  report?: ParseOptions
  /** Read the report from a path the command writes, rather than stdout. */
  reportPath?: string
  timeoutMs?: number
  version?: string
  env?: Record<string, string>
  /** Called after the command exits, before the report is read. */
  onExit?: (code: number | null, signal: string | null) => void
}

export interface CommandRunnerDeps {
  /** Injectable so the adapter is testable without spawning anything. */
  exec?: (command: readonly string[], options: CommandRunnerOptions) => Promise<{
    stdout: string
    code: number | null
    signal: string | null
  }>
  readFile?: (path: string) => Promise<string>
}

export function createCommandRunner(
  options: CommandRunnerOptions,
  deps: CommandRunnerDeps = {},
): RunnerAdapter {
  const exec = deps.exec ?? defaultExec
  const readFile = deps.readFile ?? defaultReadFile

  return {
    name: options.command[0] ?? 'command',
    version: options.version ?? '1',
    async run(request: RunRequest): Promise<RawRunResult> {
      const started = Date.now()
      const argv = [...options.command, ...request.testRefs]
      let stdout = ''
      let code: number | null = null
      let signal: string | null = null
      let timedOut = false

      try {
        const outcome = await exec(argv, {
          ...options,
          timeoutMs: options.timeoutMs ?? request.timeoutMs,
        })
        stdout = outcome.stdout
        code = outcome.code
        signal = outcome.signal
      } catch (error) {
        // A command that cannot be spawned at all is an environment failure,
        // not a test failure — the distinction matters to the Phase One gate.
        return {
          tests: [
            {
              id: `command:${request.taskId}`,
              ref: 'command',
              target: { kind: 'process', ref: options.command.join(' ') },
              status: 'errored',
              message: `could not run ${argv.join(' ')}: ${describe(error)}`,
            },
          ],
          durationMs: Date.now() - started,
        }
      }

      options.onExit?.(code, signal)
      timedOut = signal !== null && /KILL|TERM/.test(signal)

      let raw: RawRunResult | null = null
      if (options.reportPath) {
        const report = await readFile(options.reportPath)
        raw = parseWith(options, report)
      } else {
        raw = parseWith(options, stdout)
      }

      if (!raw) {
        return {
          tests: [
            {
              id: `report:${request.taskId}`,
              ref: 'report',
              target: { kind: 'process', ref: options.command.join(' ') },
              status: 'errored',
              message:
                `could not parse a test report from ${options.command[0]} ` +
                `(exit ${code ?? 'null'}); ${stdout.slice(0, 200).trim() || 'no output'}`,
            },
          ],
          durationMs: Date.now() - started,
          timedOut,
        }
      }

      return { ...raw, timedOut: timedOut || raw.timedOut }
    },
  }
}

function parseWith(options: CommandRunnerOptions, report: string): RawRunResult | null {
  if (options.report?.format === 'junit') return parseJunit(report)
  if (options.report?.format === 'tap') return parseTap(report, options.report)
  if (options.report) return parseAuto(report, options.report)
  return parseAuto(report)
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function defaultExec(
  command: readonly string[],
  options: CommandRunnerOptions,
): Promise<{ stdout: string; code: number | null; signal: string | null }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    })
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 120_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ stdout, code, signal })
    })
  })
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
