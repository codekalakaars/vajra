// CLI and process probes — Mechanism A.
//
// Spawn a command, assert on what it produced. This is the oldest and most
// complete testing mechanism there is, and it is genuinely universal: a shell
// script, a Python argparse app, a Go cobra command and a Rust clap binary are
// all just a process with an exit code and two streams.
//
// The exit code is the primary oracle and should be checked first. A command
// that printed exactly the right thing and exited non-zero has still failed,
// and asserting on stdout alone would pass it.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { RawRunResult, RawTestOutcome, RunRequest, RunnerAdapter } from '../runner.js'
import { cliTarget, type TestTarget } from '../target.js'
import { substitute } from './order.js'

export interface FileExpectation {
  path: string
  /** Substrings that must all appear. */
  contains?: readonly string[]
  /** Patterns that must all match. */
  matches?: readonly string[]
  /** The file must not exist. */
  absent?: boolean
}

export interface CliExpectation {
  /** Accepted exit codes. Defaults to `[0]`. */
  exitCode?: number | readonly number[]
  /** Exact stdout, after trimming. */
  stdout?: string
  stdoutContains?: readonly string[]
  stdoutMatches?: readonly string[]
  stderrContains?: readonly string[]
  /** Assert nothing was written to stdout — for commands that should be quiet. */
  emptyStdout?: boolean
  files?: readonly FileExpectation[]
}

export interface CliProbe {
  id: string
  /** Argv. `{{name}}` is substituted from captured variables. */
  command: readonly string[]
  cwd?: string
  env?: Record<string, string>
  expect: CliExpectation
  timeoutMs?: number
  /** Run after this probe, e.g. for cleanup. Its output is not asserted. */
  teardown?: readonly string[]
}

export interface CliTargetConfig {
  id: string
  /** Built once before probing, e.g. cargo build. Omit when already built. */
  build?: readonly (readonly string[])[]
  probes: readonly CliProbe[]
  cwd?: string
  env?: Record<string, string>
}

export interface CliTargetDeps {
  exec?: (argv: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecOutcome>
  readFile?: (path: string) => Promise<string>
}

export interface ExecOutcome {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  durationMs: number
}

export function createCliTarget(
  config: CliTargetConfig,
  deps: CliTargetDeps = {},
): RunnerAdapter {
  const exec = deps.exec ?? execDefault
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'))

  return {
    name: `cli:${config.id}`,
    version: '1',

    async run(request: RunRequest): Promise<RawRunResult> {
      const started = Date.now()
      const wanted = new Set(
        request.testRefs.length > 0 ? request.testRefs : config.probes.map((p) => p.id),
      )
      const selected = config.probes.filter((p) => wanted.has(p.id))

      // A build failure is an environment failure on every probe, exactly as a
      // server that never started is for an HTTP target. Checking the exit code
      // of the test command first prevents a missing binary from being reported
      // as a passing test.
      for (const step of config.build ?? []) {
        const result = await exec([...step], {
          cwd: config.cwd,
          env: { ...process.env, ...config.env },
          timeoutMs: request.timeoutMs,
        })
        if (result.code !== 0) {
          return {
            tests: selected.map((probe) => ({
              id: `cli:${probe.id}`,
              ref: probe.id,
              target: targetFor(probe),
              status: 'errored' as const,
              message: `build failed (${step.join(' ')}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
            })),
            durationMs: Date.now() - started,
          }
        }
      }

      const tests: RawTestOutcome[] = []
      for (const probe of selected) {
        tests.push(await runCliProbe(probe, config, exec, read, request.timeoutMs, request.cwd))
        for (const step of probe.teardown ?? []) {
          await exec([...step], {
            cwd: config.cwd,
            env: { ...process.env, ...config.env },
            timeoutMs: 10_000,
          })
        }
      }
      return { tests, durationMs: Date.now() - started }
    },
  }
}

function targetFor(probe: CliProbe): TestTarget {
  return cliTarget(probe.command.join(' '))
}

async function runCliProbe(
  probe: CliProbe,
  config: CliTargetConfig,
  exec: NonNullable<CliTargetDeps['exec']>,
  read: (path: string) => Promise<string>,
  timeoutMs: number,
  requestCwd?: string,
): Promise<RawTestOutcome> {
  const id = `cli:${probe.id}`
  const ref = probe.id
  const target = targetFor(probe)
  const argv = probe.command.map((part) => substitute(part, {}))

  let outcome: ExecOutcome
  try {
    outcome = await exec(argv, {
      cwd: probe.cwd ?? config.cwd ?? requestCwd,
      env: { ...process.env, ...config.env, ...probe.env },
      timeoutMs: probe.timeoutMs ?? timeoutMs,
    })
  } catch (error) {
    return {
      id,
      ref,
      target,
      status: 'errored',
      message: `could not run ${argv.join(' ')}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // A killed process is a timeout, which never satisfies a task in any phase.
  if (outcome.signal === 'SIGKILL' || outcome.signal === 'SIGTERM') {
    return { id, ref, target, status: 'failed', failureKind: 'environment', message: 'process timed out' }
  }

  const failures: string[] = []
  const expect = probe.expect

  const allowed = expect.exitCode === undefined ? [0] : typeof expect.exitCode === 'number' ? [expect.exitCode] : expect.exitCode
  if (outcome.code === null || !allowed.includes(outcome.code)) {
    failures.push(`exit code: expected ${allowed.join(' or ')}, got ${outcome.code ?? 'signal ' + outcome.signal}`)
  }

  const stdout = outcome.stdout.trim()
  if (expect.stdout !== undefined && stdout !== expect.stdout.trim()) {
    failures.push(`stdout: expected ${quote(expect.stdout)}, got ${quote(stdout)}`)
  }
  for (const needle of expect.stdoutContains ?? []) {
    if (!outcome.stdout.includes(needle)) failures.push(`stdout: expected to contain ${quote(needle)}`)
  }
  for (const pattern of expect.stdoutMatches ?? []) {
    if (!matches(pattern, outcome.stdout)) failures.push(`stdout: expected to match /${pattern}/`)
  }
  for (const needle of expect.stderrContains ?? []) {
    if (!outcome.stderr.includes(needle)) failures.push(`stderr: expected to contain ${quote(needle)}`)
  }
  if (expect.emptyStdout === true && stdout !== '') {
    failures.push(`stdout: expected nothing, got ${quote(stdout.slice(0, 120))}`)
  }

  for (const file of expect.files ?? []) {
    const problem = await checkFile(file, read, probe.cwd ?? config.cwd ?? requestCwd)
    if (problem) failures.push(problem)
  }

  if (failures.length === 0) return { id, ref, target, status: 'passed' }
  return {
    id,
    ref,
    target,
    status: 'failed',
    failureKind: 'assertion',
    message: failures.join('; '),
  }
}

async function checkFile(
  file: FileExpectation,
  read: (path: string) => Promise<string>,
  cwd?: string,
): Promise<string | null> {
  const path = file.path.startsWith('/') || !cwd ? file.path : `${cwd}/${file.path}`
  let content: string
  try {
    content = await read(path)
  } catch {
    return file.absent === true ? null : `file ${file.path}: expected to exist`
  }
  if (file.absent === true) return `file ${file.path}: expected not to exist`
  for (const needle of file.contains ?? []) {
    if (!content.includes(needle)) return `file ${file.path}: expected to contain ${quote(needle)}`
  }
  for (const pattern of file.matches ?? []) {
    if (!matches(pattern, content)) return `file ${file.path}: expected to match /${pattern}/`
  }
  return null
}

function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'm').test(text)
  } catch {
    return false
  }
}

function quote(value: string): string {
  return JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value)
}

async function execDefault(
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ExecOutcome> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => {
      stdout += String(c)
    })
    child.stderr?.on('data', (c) => {
      stderr += String(c)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, signal, durationMs: Date.now() - started })
    })
  })
}
