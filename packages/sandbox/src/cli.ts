#!/usr/bin/env node
// vajra-secure — sandbox the current terminal.
//
// Usage:
//   vajra-secure [options] [-- <command> [args...]]
//
// Options:
//   --project-dir <dir>   Project directory (default: cwd)
//   --env <name>          Sandbox environment name
//   --check               Check capabilities without applying
//   --shell               Launch a sandboxed shell (default if no command)
//
// What it does:
//   1. Reads .vajra-sandbox.json from the project directory
//   2. Checks platform capabilities (Landlock/Seatbelt/none)
//   3. Applies OS-level filesystem confinement to this process
//   4. Spawns the requested command (or a shell) inside the sandbox
//
// The confinement is irreversible for this process and all its children.
// Once applied, even the harness itself is subject to the policy.

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'

// ---- Load vajra-native ----

let native: typeof import('vajra-native') | null = null

try {
  // Dynamic require — the CLI may be installed without vajra-native
  // if the user only wants the policy layer (config, tool rules, etc.)
  native = require('vajra-native')
} catch {
  // vajra-native not available — sandboxing is impossible
}

// ---- Config ----

interface SecureConfig {
  projectDir: string
  environment?: string
  check: boolean
  shell: boolean
  command?: string
  args: string[]
}

function parseArgs(): SecureConfig {
  const argv = process.argv.slice(2)
  const config: SecureConfig = {
    projectDir: process.cwd(),
    check: false,
    shell: false,
    args: [],
  }

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]

    if (arg === '--project-dir' && argv[i + 1]) {
      config.projectDir = resolve(argv[++i])
    } else if (arg === '--env' && argv[i + 1]) {
      config.environment = argv[++i]
    } else if (arg === '--check') {
      config.check = true
    } else if (arg === '--shell') {
      config.shell = true
    } else if (arg === '--') {
      // Everything after -- is the command
      config.command = argv[++i]
      config.args = argv.slice(i + 1)
      break
    } else if (!arg.startsWith('-')) {
      // First non-flag arg is the command
      config.command = arg
      config.args = argv.slice(i + 1)
      break
    }

    i++
  }

  // Default to shell if no command given
  if (!config.command) {
    config.shell = true
  }

  return config
}

// ---- Load sandbox config ----

interface FileRule {
  pattern: string
  read?: boolean
  write?: boolean
  edit?: boolean
  delete?: boolean
}

interface SandboxJsonConfig {
  version?: number
  defaultPermissions?: {
    read?: boolean
    write?: boolean
    edit?: boolean
    delete?: boolean
  }
  fileRules?: FileRule[]
  files?: Record<string, { read?: boolean; write?: boolean; edit?: boolean; delete?: boolean }>
  allowedTools?: string[]
  allowUnenforced?: boolean
  readExecutePaths?: string[]
  readWritePaths?: string[]
  environments?: Record<string, Omit<SandboxJsonConfig, 'environments'>>
}

function loadSandboxConfig(projectDir: string, environment?: string): SandboxJsonConfig {
  const configPath = join(projectDir, '.vajra-sandbox.json')
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)

    if (environment && parsed.environments?.[environment]) {
      return parsed.environments[environment]
    }

    return parsed
  } catch {
    return {}
  }
}

// ---- Main ----

function printCapabilities() {
  if (!native) {
    console.log('Platform: unknown')
    console.log('Sandboxing: vajra-native not installed')
    console.log('')
    console.log('Install vajra-native for OS-level sandboxing:')
    console.log('  npm install vajra-native')
    return
  }

  const caps = native.sandboxCapabilities()
  console.log(`Platform: ${caps.platform}`)
  console.log(`Mechanism: ${caps.mechanism}`)
  console.log(`Filesystem: ${caps.filesystem}`)
  console.log(`Details: ${caps.details}`)
  if (caps.abi !== undefined && caps.abi !== null) {
    console.log(`Landlock ABI: ${caps.abi}`)
  }
}

function printHelp() {
  console.log(`
vajra-secure — sandbox the current terminal

Usage:
  vajra-secure [options] [-- <command> [args...]]

Options:
  --project-dir <dir>   Project directory (default: cwd)
  --env <name>          Sandbox environment name
  --check               Check platform capabilities without applying
  --shell               Launch a sandboxed shell (default)

Examples:
  vajra-secure                              # Sandboxed shell
  vajra-secure -- git status                # Sandboxed git
  vajra-secure --project-dir ./app -- npm test
  vajra-secure --check                      # Check capabilities only

What it does:
  1. Reads .vajra-sandbox.json from the project
  2. Checks platform capabilities (Landlock/Seatbelt/none)
  3. Applies OS-level filesystem confinement
  4. Spawns your command inside the sandbox

The confinement is irreversible — even the harness itself is confined.
`)
}

async function main() {
  const config = parseArgs()

  // Check capabilities mode
  if (config.check) {
    printCapabilities()
    return
  }

  // No vajra-native — cannot sandbox
  if (!native) {
    console.error('Error: vajra-native is not installed.')
    console.error('')
    console.error('OS-level sandboxing requires vajra-native:')
    console.error('  npm install vajra-native')
    console.error('')
    console.error('Without it, commands run with no filesystem confinement.')
    process.exit(1)
  }

  // Check capabilities
  const caps = native.sandboxCapabilities()

  if (caps.filesystem === 'unsupported') {
    const sandboxConfig = loadSandboxConfig(config.projectDir, config.environment)
    if (!sandboxConfig.allowUnenforced) {
      console.error(`Error: ${caps.details}`)
      console.error('')
      console.error('This platform cannot enforce filesystem confinement.')
      console.error('Set "allowUnenforced": true in .vajra-sandbox.json to proceed anyway.')
      process.exit(1)
    }
    console.warn(`Warning: ${caps.details}`)
    console.warn('Proceeding because allowUnenforced is set.')
  }

  // Load project permissions
  const sandboxConfig = loadSandboxConfig(config.projectDir, config.environment)
  const files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> = {}
  if (sandboxConfig.files) {
    for (const [path, perms] of Object.entries(sandboxConfig.files)) {
      files[path] = {
        read: perms.read ?? true,
        write: perms.write ?? false,
        edit: perms.edit ?? false,
        delete: perms.delete ?? false,
      }
    }
  }
  const permissions = {
    version: 1 as const,
    default: {
      read: sandboxConfig.defaultPermissions?.read ?? true,
      write: sandboxConfig.defaultPermissions?.write ?? false,
      edit: sandboxConfig.defaultPermissions?.edit ?? false,
      delete: sandboxConfig.defaultPermissions?.delete ?? false,
    },
    files,
  }

  // Apply sandbox
  console.log(`Applying sandbox to: ${config.projectDir}`)
  console.log(`Platform: ${caps.platform} (${caps.mechanism})`)
  console.log('')

  let result: ReturnType<typeof native.applySandbox>
  try {
    result = native.applySandbox({
      projectDir: config.projectDir,
      permissions,
      allowUnenforced: sandboxConfig.allowUnenforced,
    })
  } catch (e) {
    console.error(`Failed to apply sandbox: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`Warning: ${warning}`)
    }
    console.log('')
  }

  if (result.enforced) {
    console.log(`Sandbox active: ${result.mechanism}`)
  } else {
    console.log('Sandbox applied (no enforcement on this platform)')
  }
  console.log('')

  // Determine shell
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')

  // Spawn command or shell
  if (config.command) {
    const child = spawn(config.command, config.args, {
      stdio: 'inherit',
      cwd: config.projectDir,
      env: process.env,
    })

    child.on('exit', (code) => {
      process.exit(code ?? 0)
    })
  } else {
    // Launch interactive shell
    const child = spawn(shell, [], {
      stdio: 'inherit',
      cwd: config.projectDir,
      env: process.env,
    })

    child.on('exit', (code) => {
      process.exit(code ?? 0)
    })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
