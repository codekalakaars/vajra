// vajra secure — sandbox the current terminal.
// Reads .vajra-sandbox.json, applies OS-level confinement, spawns a command.

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { expandFileRules } from './file-rules.js'
import type { FileRule } from './config.js'

type NativeModule = typeof import('@codekalakaars/vajra-core')

interface SecureConfig {
  projectDir: string
  environment?: string
  check: boolean
  command?: string
  args: string[]
}

function parseArgs(): SecureConfig {
  const argv = process.argv.slice(2)
  const config: SecureConfig = {
    projectDir: process.cwd(),
    check: false,
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
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--') {
      config.command = argv[++i]
      config.args = argv.slice(i + 1)
      break
    } else if (!arg.startsWith('-')) {
      config.command = arg
      config.args = argv.slice(i + 1)
      break
    }

    i++
  }

  return config
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
  if (!existsSync(configPath)) return {}

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

function printCapabilities(native: NativeModule | null) {
  if (!native) {
    console.log('Platform: unknown')
    console.log('Sandboxing: vajra-core not installed')
    console.log('')
    console.log('Install vajra-core for OS-level sandboxing:')
    console.log('  npm install @codekalakaars/vajra-core')
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
vajra secure — sandbox the current terminal

Usage:
  vajra secure [options] [-- <command> [args...]]

Options:
  --project-dir <dir>   Project directory (default: cwd)
  --env <name>          Sandbox environment name
  --check               Check platform capabilities without applying

Examples:
  vajra secure                              # Sandboxed shell
  vajra secure -- git status                # Sandboxed git
  vajra secure --project-dir ./app -- npm test
  vajra secure --check                      # Check capabilities only

The confinement is irreversible — even the harness itself is confined.
`)
}

export async function run(native: NativeModule | null) {
  const config = parseArgs()

  if (config.check) {
    printCapabilities(native)
    return
  }

  if (!native) {
    console.error('Error: vajra-core is not installed.')
    console.error('')
    console.error('OS-level sandboxing requires vajra-core:')
    console.error('  npm install @codekalakaars/vajra-core')
    process.exit(1)
  }

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

  const sandboxConfig = loadSandboxConfig(config.projectDir, config.environment)
  const defaultPerms = {
    read: sandboxConfig.defaultPermissions?.read ?? true,
    write: sandboxConfig.defaultPermissions?.write ?? false,
    edit: sandboxConfig.defaultPermissions?.edit ?? false,
    delete: sandboxConfig.defaultPermissions?.delete ?? false,
  }

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

  if (sandboxConfig.fileRules && sandboxConfig.fileRules.length > 0) {
    const expanded = expandFileRules(config.projectDir, sandboxConfig.fileRules, defaultPerms)
    for (const [path, perms] of Object.entries(expanded)) {
      files[path] = perms
    }
  }

  const permissions = {
    version: 1 as const,
    default: defaultPerms,
    files,
  }

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

  const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')

  const child = config.command
    ? spawn(config.command, config.args, { stdio: 'inherit', cwd: config.projectDir, env: process.env })
    : spawn(shell, [], { stdio: 'inherit', cwd: config.projectDir, env: process.env })

  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}
