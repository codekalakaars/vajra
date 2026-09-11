// vajra sandbox — manage the sandbox daemon.
//
// Usage:
//   vajra sandbox start [--project-dir <dir>] [--env <name>]
//   vajra sandbox stop [--project-dir <dir>]
//   vajra sandbox status [--project-dir <dir>]
//   vajra sandbox locks [--project-dir <dir>]
//   vajra sandbox agents [--project-dir <dir>]

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

// ---- Helpers ----

function getProjectDir(): string {
  const idx = process.argv.indexOf('--project-dir')
  if (idx !== -1 && process.argv[idx + 1]) {
    return resolve(process.argv[idx + 1])
  }
  return process.cwd()
}

function getEnvironment(): string | undefined {
  const idx = process.argv.indexOf('--env')
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1]
  }
  return undefined
}

function hashProjectDir(projectDir: string): string {
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 16)
}

function getSocketPath(projectDir: string): string {
  return `/tmp/vajra-sandbox-${hashProjectDir(projectDir)}.sock`
}

function getDaemonPidPath(projectDir: string): string {
  return `/tmp/vajra-sandbox-${hashProjectDir(projectDir)}.pid`
}

function saveDaemonPid(projectDir: string, pid: number): void {
  writeFileSync(getDaemonPidPath(projectDir), String(pid), 'utf-8')
}

function loadDaemonPid(projectDir: string): number | null {
  const path = getDaemonPidPath(projectDir)
  if (!existsSync(path)) return null
  try {
    return parseInt(readFileSync(path, 'utf-8').trim(), 10)
  } catch {
    return null
  }
}

function removeDaemonPid(projectDir: string): void {
  try {
    unlinkSync(getDaemonPidPath(projectDir))
  } catch {}
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- Commands ----

async function cmdStart(): Promise<void> {
  const projectDir = getProjectDir()
  const environment = getEnvironment()
  const socketPath = getSocketPath(projectDir)

  const existingPid = loadDaemonPid(projectDir)
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Sandbox daemon already running (PID: ${existingPid})`)
    console.log(`Socket: ${socketPath}`)
    console.log(`Project: ${projectDir}`)
    return
  }

  removeDaemonPid(projectDir)
  console.log(`Starting sandbox daemon...`)
  console.log(`Project: ${projectDir}`)
  if (environment) console.log(`Environment: ${environment}`)
  console.log(`Socket: ${socketPath}`)

  // Import and create daemon dynamically
  const { SandboxDaemon } = await import('./daemon.js')
  const daemon = new SandboxDaemon({ projectDir, socketPath, environment })

  try {
    await daemon.start()
    saveDaemonPid(projectDir, process.pid)
    console.log(`\nSandbox daemon started (PID: ${process.pid})`)
    console.log(`\nAI agents can now connect to:`)
    console.log(`  Socket: ${socketPath}`)
    console.log(`\nTo stop: vajra sandbox stop`)
    console.log(`To check status: vajra sandbox status`)

    process.on('SIGINT', async () => {
      console.log('\nShutting down...')
      await daemon.stop()
      removeDaemonPid(projectDir)
      process.exit(0)
    })
    process.on('SIGTERM', async () => {
      await daemon.stop()
      removeDaemonPid(projectDir)
      process.exit(0)
    })
  } catch (e) {
    console.error(`Failed to start sandbox daemon: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}

async function cmdStop(): Promise<void> {
  const projectDir = getProjectDir()
  const pid = loadDaemonPid(projectDir)
  if (!pid || !isProcessRunning(pid)) {
    console.log('No sandbox daemon running for this project')
    removeDaemonPid(projectDir)
    return
  }

  console.log(`Stopping sandbox daemon (PID: ${pid})...`)
  try {
    process.kill(pid, 'SIGTERM')
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!isProcessRunning(pid)) {
          clearInterval(check)
          resolve()
        }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 5000)
    })
    removeDaemonPid(projectDir)
    console.log('Sandbox daemon stopped')
  } catch (e) {
    console.error(`Failed to stop daemon: ${e instanceof Error ? e.message : String(e)}`)
    removeDaemonPid(projectDir)
  }
}

async function cmdStatus(): Promise<void> {
  const projectDir = getProjectDir()
  const pid = loadDaemonPid(projectDir)
  if (!pid || !isProcessRunning(pid)) {
    console.log('Status: NOT RUNNING')
    console.log(`Project: ${projectDir}`)
    return
  }

  const { SandboxClient } = await import('./client.js')
  const client = new SandboxClient({ socketPath: getSocketPath(projectDir) })
  try {
    await client.connect()
    const response = await client.getStatus()
    await client.disconnect()
    const status = response.status as Record<string, unknown>
    console.log('Status: RUNNING')
    console.log(`PID: ${pid}`)
    console.log(`Project: ${status.projectDir}`)
    console.log(`Socket: ${status.socketPath}`)

    const agents = status.agents as Array<Record<string, unknown>>
    console.log(`\nConnected agents: ${agents.length}`)
    for (const agent of agents) {
      const uptime = Math.round((Date.now() - (agent.connectedAt as number)) / 1000)
      console.log(`  - ${agent.name} (ID: ${String(agent.id).slice(0, 8)}..., uptime: ${uptime}s)`)
    }

    const locks = status.locks as Array<Record<string, unknown>>
    console.log(`\nActive locks: ${locks.length}`)
    for (const lock of locks) {
      console.log(`  - ${lock.file} [${lock.mode}] owned by ${String(lock.owner).slice(0, 8)}...`)
    }
  } catch (e) {
    console.log('Status: ERROR (daemon may be starting up)')
    console.log(`PID: ${pid}`)
    console.log(`Error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function cmdLocks(): Promise<void> {
  const projectDir = getProjectDir()
  const { SandboxClient } = await import('./client.js')
  const client = new SandboxClient({ socketPath: getSocketPath(projectDir) })
  try {
    await client.connect()
    const response = await client.listLocks()
    await client.disconnect()
    if (response.locks.length === 0) {
      console.log('No active file locks')
      return
    }
    console.log(`Active file locks (${response.locks.length}):`)
    for (const lock of response.locks) {
      console.log(`  ${lock.file}`)
      console.log(`    Mode: ${lock.mode} | Owner: ${lock.owner}`)
    }
  } catch (e) {
    console.error(`Failed to query locks: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}

async function cmdAgents(): Promise<void> {
  const projectDir = getProjectDir()
  const { SandboxClient } = await import('./client.js')
  const client = new SandboxClient({ socketPath: getSocketPath(projectDir) })
  try {
    await client.connect()
    const response = await client.listAgents()
    await client.disconnect()
    if (response.agents.length === 0) {
      console.log('No connected agents')
      return
    }
    console.log(`Connected agents (${response.agents.length}):`)
    for (const agent of response.agents) {
      const uptime = Math.round((Date.now() - (agent.connectedAt as number)) / 1000)
      console.log(`  ${agent.name}`)
      console.log(`    ID: ${agent.id}`)
      if (agent.pid) console.log(`    PID: ${agent.pid}`)
      console.log(`    Connected: ${uptime}s ago`)
    }
  } catch (e) {
    console.error(`Failed to query agents: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}

function printHelp() {
  console.log(`
vajra sandbox — manage the sandbox daemon

Usage:
  vajra sandbox <command> [options]

Commands:
  start    Start the sandbox daemon
  stop     Stop the sandbox daemon
  status   Show daemon status and active locks
  locks    List active file locks
  agents   List connected agents

Options:
  --project-dir <dir>  Project directory (default: current directory)
  --env <name>         Sandbox environment name
`)
}

export async function run(): Promise<void> {
  const command = process.argv[2]

  switch (command) {
    case 'start': await cmdStart(); break
    case 'stop': await cmdStop(); break
    case 'status': await cmdStatus(); break
    case 'locks': await cmdLocks(); break
    case 'agents': await cmdAgents(); break
    case '--help': case '-h': printHelp(); break
    default:
      if (command && !command.startsWith('-')) {
        console.error(`Unknown sandbox command: ${command}`)
      }
      printHelp()
      break
  }
}
