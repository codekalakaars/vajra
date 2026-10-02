
/**
 * Parse a C1 run_command result. Non-JSON or missing exitCode is failure —
 * never the old `exitCode = 0` fallback (C2t).
 */
export function parseCommandResult(output: string): {
  ok: boolean
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
} {
  try {
    const parsed = JSON.parse(output) as {
      exitCode?: number
      signal?: string | null
      stdout?: string
      stderr?: string
    }
    if (typeof parsed.exitCode !== 'number') {
      return { ok: false, exitCode: -1, signal: null, stdout: output, stderr: 'Malformed run_command result' }
    }
    const signal = parsed.signal ?? null
    const ok = parsed.exitCode === 0 && signal === null
    return {
      ok,
      exitCode: parsed.exitCode,
      signal,
      stdout: parsed.stdout ?? '',
      stderr: parsed.stderr ?? '',
    }
  } catch {
    // Bare string success from an older handle is still not trusted (C1).
    return {
      ok: false,
      exitCode: -1,
      signal: null,
      stdout: output,
      stderr: 'run_command did not return JSON {exitCode, signal, stdout, stderr}',
    }
  }
}

export async function killProcessGroup(
  serverProcess: ReturnType<typeof import('node:child_process').spawn>,
): Promise<void> {
  // Consume piped stdout/stderr so the buffer cannot fill and stall the server.
  serverProcess.stdout?.resume()
  serverProcess.stderr?.resume()
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return
  try {
    if (serverProcess.pid) {
      // Negative pid signals the process group (spawn used detached: true).
      process.kill(-serverProcess.pid, 'SIGTERM')
    }
  } catch {
    try {
      serverProcess.kill('SIGTERM')
    } catch {
      // already dead
    }
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        if (serverProcess.pid) process.kill(-serverProcess.pid, 'SIGKILL')
      } catch { /* ignore */ }
      resolve()
    }, 3000)
    serverProcess.once('close', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

export function waitForServerStartup(
  serverProcess: ReturnType<typeof import('node:child_process').spawn>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (started: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      serverProcess.off('error', onError)
      serverProcess.off('exit', onExit)
      resolve(started)
    }
    const onError = () => finish(false)
    const onExit = () => finish(false)
    const timer = setTimeout(() => finish(true), timeoutMs)
    serverProcess.once('error', onError)
    serverProcess.once('exit', onExit)
  })
}
