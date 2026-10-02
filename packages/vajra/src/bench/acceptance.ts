import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  statSync
} from 'node:fs'
import { join
} from 'node:path'
import { BenchAcceptance, BenchSetupError } from './suite.js'

/**
 * Copy a suite's acceptance tests in and run them against the finished tree.
 *
 * Copied as a directory, not flattened: a suite's tests belong together and must
 * not collide with a file the plan created.
 */
export function runAcceptance(
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
