#!/usr/bin/env node

// Standalone sandbox CLI.
//
// Usage:
//   vajra-sandbox start [--project-dir <dir>] [--env <name>]
//   vajra-sandbox stop [--project-dir <dir>]
//   vajra-sandbox status [--project-dir <dir>]
//   vajra-sandbox locks [--project-dir <dir>]
//   vajra-sandbox agents [--project-dir <dir>]
//
// The daemon runs in the background and manages file locks and permissions
// for AI coding assistants (Claude Code, Cursor, Copilot, etc.) that run
// inside the sandbox.

import { SandboxDaemon, type DaemonConfig } from './daemon.js'
import { SandboxClient } from './client.js'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'

// ---- Config ----

function getProjectDir(): string {
  const idx = process.argv.indexOf('--project-dir')
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1]
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

function getSocketPath(projectDir: string): string {
  const hash = Buffer.from(projectDir).toString('base64url').slice(0, 32)
  return `/tmp/vajra-sandbox-${hash}.sock`
}

function getDaemonPidPath(projectDir: string): string {
  const hash = Buffer.from(projectDir).toString('base64url').slice(0, 32)
  return `/tmp/vajra-sandbox-${hash}.pid`
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
  } catch {
    // Ignore
  }
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
  const pidPath = getDaemonPidPath(projectDir)

  // Check if already running
  const existingPid = loadDaemonPid(projectDir)
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Sandbox daemon already running (PID: ${existingPid})`)
    console.log(`Socket: ${socketPath}`)
    console.log(`Project: ${projectDir}`)
    return
  }

  // Clean up stale PID file
  removeDaemonPid(projectDir)

  console.log(`Starting sandbox daemon...`)
  console.log(`Project: ${projectDir}`)
  if (environment) console.log(`Environment: ${environment}`)
  console.log(`Socket: ${socketPath}`)

  const config: DaemonConfig = {
    projectDir,
    socketPath,
    environment,
  }

  const daemon = new SandboxDaemon(config)

  try {
    await daemon.start()

    // Save PID for status/stop commands
    saveDaemonPid(projectDir, process.pid)

    console.log(`\nSandbox daemon started (PID: ${process.pid})`)
    console.log(`\nAI agents can now connect to:`)
    console.log(`  Socket: ${socketPath}`)
    console.log(`\nTo stop: vajra-sandbox stop`)
    console.log(`To check status: vajra-sandbox status`)

    // Keep the process running
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
    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!isProcessRunning(pid)) {
          clearInterval(check)
          resolve()
        }
      }, 100)
      // Timeout after 5 seconds
      setTimeout(() => {
        clearInterval(check)
        resolve()
      }, 5000)
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
  const socketPath = getSocketPath(projectDir)
  const pid = loadDaemonPid(projectDir)

  if (!pid || !isProcessRunning(pid)) {
    console.log('Status: NOT RUNNING')
    console.log(`Project: ${projectDir}`)
    console.log(`Socket: ${socketPath}`)
    return
  }

  const client = new SandboxClient({ socketPath })
  try {
    await client.connect()
    const response = await client.getStatus()
    await client.disconnect()

    const status = response.status
    console.log('Status: RUNNING')
    console.log(`PID: ${pid}`)
    console.log(`Project: ${status.projectDir}`)
    console.log(`Socket: ${status.socketPath}`)
    console.log(`\nConnected agents: ${status.agents.length}`)
    for (const agent of status.agents) {
      const uptime = Math.round((Date.now() - agent.connectedAt) / 1000)
      console.log(`  - ${agent.name} (ID: ${agent.id.slice(0, 8)}..., uptime: ${uptime}s)`)
    }
    console.log(`\nActive locks: ${status.locks.length}`)
    for (const lock of status.locks) {
      console.log(`  - ${lock.file} [${lock.mode}] owned by ${lock.owner.slice(0, 8)}...`)
    }
    console.log(`\nConfig:`)
    console.log(`  Default permissions: R=${status.config.defaultPermissions.read} W=${status.config.defaultPermissions.write} E=${status.config.defaultPermissions.edit} D=${status.config.defaultPermissions.delete}`)
    console.log(`  File rules: ${status.config.fileRulesCount}`)
    console.log(`  Allowed tools: ${status.config.allowedTools ? status.config.allowedTools.join(', ') : '(all)'}`)
  } catch (e) {
    console.log('Status: ERROR (daemon may be starting up)')
    console.log(`PID: ${pid}`)
    console.log(`Error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function cmdLocks(): Promise<void> {
  const projectDir = getProjectDir()
  const socketPath = getSocketPath(projectDir)

  const client = new SandboxClient({ socketPath })
  try {
    await client.connect()
    const response = await client.listLocks()
    await client.disconnect()

    const locks = response.locks
    if (locks.length === 0) {
      console.log('No active file locks')
      return
    }

    console.log(`Active file locks (${locks.length}):`)
    for (const lock of locks) {
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
  const socketPath = getSocketPath(projectDir)

  const client = new SandboxClient({ socketPath })
  try {
    await client.connect()
    const response = await client.listAgents()
    await client.disconnect()

    const agents = response.agents
    if (agents.length === 0) {
      console.log('No connected agents')
      return
    }

    console.log(`Connected agents (${agents.length}):`)
    for (const agent of agents) {
      const uptime = Math.round((Date.now() - agent.connectedAt) / 1000)
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

// ---- Main ----

async function main(): Promise<void> {
  const command = process.argv[2]

  switch (command) {
    case 'start':
      await cmdStart()
      break
    case 'stop':
      await cmdStop()
      break
    case 'status':
      await cmdStatus()
      break
    case 'locks':
      await cmdLocks()
      break
    case 'agents':
      await cmdAgents()
      break
    default:
      console.log(`
Vajra Sandbox — isolate AI coding assistants

Usage:
  vajra-sandbox <command> [options]

Commands:
  start    Start the sandbox daemon
  stop     Stop the sandbox daemon
  status   Show daemon status and active locks
  locks    List active file locks
  agents   List connected agents

Options:
  --project-dir <dir>  Project directory (default: current directory)
  --env <name>         Sandbox environment name

Examples:
  vajra-sandbox start                          # Start daemon in current project
  vajra-sandbox start --project-dir ./my-app   # Start daemon for specific project
  vajra-sandbox status                         # Check daemon status
  vajra-sandbox stop                           # Stop the daemon

AI Agent Integration:
  1. Start the sandbox: vajra-sandbox start
  2. Run your AI assistant inside the sandbox
  3. The daemon manages file locks and permissions
  4. Stop when done: vajra-sandbox stop
`)
      break
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
