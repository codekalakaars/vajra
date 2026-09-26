// Build, serve, wait, tear down.
//
// This is the piece that makes a TypeScript, Python or Java API testable
// without three separate implementations. Each language differs only in its
// build and serve commands; readiness is polled rather than slept on, so a
// slow start costs latency instead of a fixed guess, and a fast start is not
// penalised by a timeout that was sized for the slowest language.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { BuildStep, ReadyCheck, ServeStep, TemplateValue } from './config.js'

export interface StepResult {
  command: readonly string[]
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
}

export interface ExecDeps {
  runStep?: (step: BuildStep | ServeStep, env: NodeJS.ProcessEnv) => Promise<StepResult>
  spawnServer?: (step: ServeStep, env: NodeJS.ProcessEnv) => ManagedProcess
  findPort?: () => Promise<number>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: typeof fetch
}

export interface ManagedProcess {
  readonly pid?: number
  readonly output: () => string
  kill: (signal: NodeJS.Signals) => void
  exited: Promise<{ code: number | null; signal: string | null }>
}

export class HarnessError extends Error {
  constructor(
    message: string,
    readonly stage: 'build' | 'serve' | 'ready' | 'probe',
    readonly detail?: StepResult,
  ) {
    super(message)
    this.name = 'HarnessError'
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

/**
 * Render `${VAR}` templates. Language config is written by a Developer once
 * and reused, so the port has to be injectable rather than hard-coded.
 */
export function applyTemplates(
  values: Record<string, string | TemplateValue> | undefined,
  context: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values ?? {})) {
    const text = Array.isArray(value) ? value.join(',') : String(value)
    out[key] = text.replace(/\$\{(\w+)\}/g, (match, name: string) => context[name] ?? match)
  }
  return out
}

export function renderCommand(
  command: readonly string[],
  context: Record<string, string>,
): string[] {
  return command.map((part) =>
    part.replace(/\$\{(\w+)\}/g, (match, name: string) => context[name] ?? match),
  )
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export interface HarnessOptions {
  config: { build?: readonly BuildStep[]; serve: ServeStep; env?: Record<string, string | TemplateValue> }
  cwd?: string
  /** Run build steps. Disabled when the caller has already built. */
  build?: boolean
}

export class ApiHarness {
  private process: ManagedProcess | undefined
  private portValue: number | undefined
  private readonly deps: Required<Pick<ExecDeps, 'runStep' | 'spawnServer' | 'findPort' | 'now' | 'sleep'>> & {
    fetchImpl: typeof fetch
  }

  constructor(
    private readonly options: HarnessOptions,
    deps: ExecDeps = {},
  ) {
    const now = deps.now ?? (() => Date.now())
    this.deps = {
      runStep: deps.runStep ?? runStepDefault,
      spawnServer: deps.spawnServer ?? spawnServerDefault,
      findPort: deps.findPort ?? findFreePort,
      now,
      sleep: deps.sleep ?? defaultSleep,
      fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    }
  }

  get port(): number {
    if (this.portValue === undefined) throw new HarnessError('harness not started', 'serve')
    return this.portValue
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private context(): Record<string, string> {
    return { PORT: String(this.portValue ?? ''), BASE_URL: this.portValue ? this.baseUrl : '' }
  }

  private env(): NodeJS.ProcessEnv {
    const ctx = this.context()
    return {
      ...process.env,
      ...applyTemplates(this.options.config.env, ctx),
      PORT: ctx.PORT,
      VAJRA_BASE_URL: ctx.BASE_URL,
      // Language toolchains routinely read these and behave differently when
      // they are set, which would make results depend on the harness.
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
      CI: '1',
    } as NodeJS.ProcessEnv
  }

  async start(): Promise<StepResult[]> {
    const built: StepResult[] = []
    if (this.options.build !== false) {
      for (const step of this.options.config.build ?? []) {
        const result = await this.deps.runStep(
          { ...step, run: renderCommand(step.run, this.context()) },
          this.env(),
        )
        built.push(result)
        if (!step.optional && result.code !== 0) {
          throw new HarnessError(
            `build step failed: ${result.command.join(' ')}`,
            'build',
            result,
          )
        }
      }
    }
    await this.serve()
    return built
  }

  private async serve(): Promise<void> {
    const serve = this.options.config.serve
    // `port: 0` means "let the OS pick", which is the default so two targets
    // running at once cannot collide. Treating 0 as a literal port would dial
    // port 0 and fail in a way that looks like a dead server.
    this.portValue = serve.port && serve.port > 0 ? serve.port : await this.deps.findPort()
    const ctx = this.context()

    this.process = this.deps.spawnServer(
      { ...serve, run: renderCommand(serve.run, ctx) },
      this.env(),
    )

    const timeoutMs = serve.timeoutMs ?? 30_000
    try {
      await this.waitForReady(serve.ready ?? { kind: 'delay', ms: 250 }, timeoutMs)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  private async waitForReady(check: ReadyCheck, timeoutMs: number): Promise<void> {
    const deadline = this.deps.now() + timeoutMs
    const interval = check.kind === 'delay' ? check.ms : 50

    for (;;) {
      if (await this.probeReady(check)) return
      if (this.deps.now() >= deadline) {
        throw new HarnessError(
          `server did not become ready within ${timeoutMs}ms (${check.kind} check)`,
          'ready',
        )
      }
      if (check.kind === 'delay') {
        await this.deps.sleep(interval)
        return
      }
      // If the process died while we were waiting, fail now rather than
      // polling a dead port until the timeout.
      if (this.process) {
        const exited = await Promise.race([
          this.process.exited.then(() => true),
          this.deps.sleep(0).then(() => false),
        ])
        if (exited) {
          throw new HarnessError(
            `server exited before becoming ready: ${this.process.output().slice(-400)}`,
            'ready',
          )
        }
      }
      await this.deps.sleep(interval)
    }
  }

  private async probeReady(check: ReadyCheck): Promise<boolean> {
    try {
      if (check.kind === 'delay') return true
      if (check.kind === 'log') {
        return new RegExp(check.pattern).test(this.process?.output() ?? '')
      }
      if (check.kind === 'tcp') {
        const { connect } = await import('node:net')
        return new Promise<boolean>((resolve) => {
          const socket = connect({ port: this.port, host: '127.0.0.1' })
          const done = (value: boolean): void => {
            socket.destroy()
            resolve(value)
          }
          socket.once('connect', () => done(true))
          socket.once('error', () => done(false))
        })
      }
      const response = await this.deps.fetchImpl(
        `${this.baseUrl}${check.path.startsWith('/') ? '' : '/'}${check.path}`,
        { signal: AbortSignal.timeout(2000) },
      )
      const allowed: readonly number[] =
        check.status === undefined
          ? [200, 201, 202, 204]
          : typeof check.status === 'number'
            ? [check.status]
            : check.status
      return response.ok || allowed.includes(response.status)
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    const proc = this.process
    this.process = undefined
    if (!proc) return
    const grace = this.options.config.serve.shutdownMs ?? 3000
    try {
      proc.kill('SIGTERM')
    } catch {
      return
    }
    const terminated = await Promise.race([
      proc.exited.then(() => true),
      this.deps.sleep(grace).then(() => false),
    ])
    if (terminated) return
    try {
      proc.kill('SIGKILL')
      // Bounded even after SIGKILL. A process that ignores both signals, or a
      // platform where kill is a no-op, must not be able to hang verification
      // forever — a stuck teardown would stall the Manager's whole loop.
      await Promise.race([proc.exited, this.deps.sleep(grace)])
    } catch {
      /* already gone */
    }
  }
}

async function runStepDefault(
  step: BuildStep | ServeStep,
  env: NodeJS.ProcessEnv,
): Promise<StepResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(step.run[0], step.run.slice(1), {
      cwd: step.cwd,
      env,
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
    const timer = setTimeout(() => child.kill('SIGKILL'), step.timeoutMs ?? 300_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        command: step.run,
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        durationMs: Date.now() - started,
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ command: step.run, code, signal, stdout, stderr, durationMs: Date.now() - started })
    })
  })
}

function spawnServerDefault(step: ServeStep, env: NodeJS.ProcessEnv): ManagedProcess {
  const child: ChildProcess = spawn(step.run[0], step.run.slice(1), {
    cwd: step.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (c) => {
    output += String(c)
  })
  child.stderr?.on('data', (c) => {
    output += String(c)
  })
  return {
    pid: child.pid,
    output: () => output,
    kill: (signal) => child.kill(signal),
    exited: new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }))
    }),
  }
}
