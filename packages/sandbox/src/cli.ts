#!/usr/bin/env node

// Standalone sandbox CLI.
//
// Usage:
//   vajra secure [--project-dir <dir>] [-- <command>]
//   vajra status
//   vajra config [--project-dir]
//   vajra test  [--project-dir]
//
// The sandbox uses kernel-level confinement (Landlock on Linux, Seatbelt on
// macOS) to restrict file access. The `secure` command applies the sandbox
// and runs a command inside it.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const native = require('vajra-native')

// ---- Helpers ----

function getProjectDir(): string {
  const idx = process.argv.indexOf('--project-dir')
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1]
  }
  return process.cwd()
}

// ---- Commands ----

function cmdStatus(): void {
  const caps = native.sandboxCapabilities()

  console.log('Vajra Sandbox — capabilities\n')
  console.log(`  Platform:   ${caps.platform}`)
  console.log(`  Filesystem: ${caps.filesystem}`)
  console.log(`  Mechanism:  ${caps.mechanism}`)
  console.log(`  Details:    ${caps.details}`)
  if (caps.abi) {
    console.log(`  ABI:        ${caps.abi}`)
  }

  if (caps.filesystem === 'unsupported') {
    console.log('\n  ⚠️  No sandbox mechanism available on this platform.')
    console.log('     An agent run here can read and write anything the user can.')
  } else if (caps.filesystem === 'partial') {
    console.log('\n  ⚠️  Partial enforcement — some restrictions may not work.')
  } else {
    console.log('\n  ✅ Full sandbox enforcement available.')
  }
}

function cmdConfig(): void {
  const projectDir = getProjectDir()
  const configPath = join(projectDir, '.vajra-sandbox.json')

  if (existsSync(configPath)) {
    // Show existing config
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const config = JSON.parse(raw)
      console.log(`Configuration: ${configPath}\n`)
      console.log(JSON.stringify(config, null, 2))
    } catch (e) {
      console.error(`Error reading config: ${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    }
  } else {
    // Create default config
    const defaultConfig = {
      version: 1,
      projectDir,
      defaultPermissions: { read: true, write: false, edit: false, delete: false },
      fileRules: [],
      allowedTools: null,
      allowUnenforced: false,
    }

    try {
      writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8')
      console.log(`Created: ${configPath}`)
      console.log('\nDefault configuration:')
      console.log('  - Read: allowed')
      console.log('  - Write: denied')
      console.log('  - Edit: denied')
      console.log('  - Delete: denied')
      console.log('\nEdit .vajra-sandbox.json to customize permissions.')
    } catch (e) {
      console.error(`Error creating config: ${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    }
  }
}

function cmdTest(): void {
  const projectDir = getProjectDir()
  const caps = native.sandboxCapabilities()

  console.log('Vajra — testing sandbox\n')
  console.log(`  Project: ${projectDir}`)
  console.log(`  Platform: ${caps.platform}`)
  console.log(`  Mechanism: ${caps.mechanism}`)

  if (caps.filesystem === 'unsupported') {
    console.log('\n  ❌ Cannot test — no sandbox mechanism available.')
    console.log('     On Linux, requires kernel 5.13+ with Landlock.')
    console.log('     On macOS, Seatbelt is always available.')
    process.exit(1)
  }

  console.log('\n  Testing sandbox confinement...')

  try {
    const result = native.applySandbox({
      projectDir,
      permissions: {
        version: 1,
        default: { read: true, write: false, edit: false, delete: false },
        files: {},
      },
      allowUnenforced: false,
    })

    if (result.enforced) {
      console.log(`\n  ✅ Sandbox applied: ${result.mechanism}`)
    } else {
      console.log(`\n  ⚠️  Sandbox not enforced: ${result.mechanism}`)
    }

    if (result.warnings.length > 0) {
      console.log('\n  Warnings:')
      for (const w of result.warnings) {
        console.log(`    - ${w}`)
      }
    }

    console.log('\n  This process is now confined to:')
    console.log(`    ${projectDir}`)
    console.log('\n  Note: Sandbox is irreversible for this process.')
  } catch (e) {
    console.error(`\n  ❌ Failed to apply sandbox: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}

function cmdSecure(): void {
  const projectDir = getProjectDir()
  const caps = native.sandboxCapabilities()

  if (caps.filesystem === 'unsupported') {
    console.error('❌ Cannot secure — no sandbox mechanism available.')
    console.error('   On Linux, requires kernel 5.13+ with Landlock.')
    console.error('   On macOS, Seatbelt is always available.')
    process.exit(1)
  }

  // Get command after -- separator
  const dashDashIdx = process.argv.indexOf('--')
  const commandArgs = dashDashIdx !== -1 ? process.argv.slice(dashDashIdx + 1) : []

  // Write profile file BEFORE applying sandbox (sandbox blocks writes outside project)
  const profilePath = join(projectDir, `.vajra-profile-${process.pid}.sh`)
  let needsProfile = commandArgs.length === 0

  if (needsProfile) {
    const shell = process.env.SHELL || '/bin/bash'

    // Generate random exit token — agent can't guess this
    const exitToken = randomBytes(16).toString('hex')

    // Strip network tools AND interpreters from PATH
    // Interpreters (python, node, ruby, perl, etc.) can bypass shell aliases
    // by using their own socket/HTTP libraries
    const blockedDirs = ['/sbin', '/usr/sbin']
    const blockedBins = ['python', 'python3', 'python3.10', 'python3.12',
      'node', 'nodejs', 'ruby', 'perl', 'php', 'lua', 'tclsh',
      'curl', 'wget', 'git', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'socat',
      'ncat', 'nmap', 'socat', 'telnet', 'ftp', 'sftp', 'rsh', 'rexec',
      'docker', 'podman', 'lxc', 'qemu']
    const safePath = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin')
      .split(':')
      .filter(p => !blockedDirs.some(b => p.includes(b)))
      .join(':')

    const profileContent = [
      '# Vajra sandbox — generated profile',
      'set -o ignoreeof',
      '',
      '# Strip dangerous dirs from PATH',
      'export PATH="' + safePath + '"',
      '',
      '# Logging function',
      '_vajra_log() { echo "[VAJRA BLOCKED] $1 — $2" >&2; }',
      '',
      '# List of blocked commands with alternatives',
      '_vajra_blocked="curl wget git ssh scp rsync nc ncat socat nmap telnet ftp sftp',
      'python python3 python3.10 python3.12 node nodejs ruby perl php lua',
      'docker podman lxc qemu rsh rexec"',
      '',
      '# Block command — catches "command curl" bypass',
      '_vajra_real_command() { builtin command "$@"; }',
      'command() {',
      '  local cmd="$1"',
      '  if echo "$_vajra_blocked" | grep -qw "$cmd"; then',
      '    case "$cmd" in',
      '      curl|wget) _vajra_log "$cmd" "Use read_file or list_files tools instead"; return 1 ;;',
      '      git) _vajra_log "$cmd" "File operations are done through the sandbox tools"; return 1 ;;',
      '      ssh|scp|rsync|nc|ncat|socat|telnet|ftp|sftp) _vajra_log "$cmd" "Network access is restricted in the sandbox"; return 1 ;;',
      '      python|python3|node|nodejs|ruby|perl|php|lua) _vajra_log "$cmd" "Interpreter access is restricted — use shell builtins"; return 1 ;;',
      '      docker|podman|lxc|qemu) _vajra_log "$cmd" "Container access is restricted in the sandbox"; return 1 ;;',
      '      *) _vajra_log "$cmd" "This command is not available in the sandbox"; return 1 ;;',
      '    esac',
      '  fi',
      '  builtin command "$@"',
      '}',
      '',
      '# Block direct path invocations — catches "/usr/bin/curl" bypass',
      'env() {',
      '  if echo "$_vajra_blocked" | grep -qw "$1"; then',
      '    _vajra_log "$1" "Direct path invocation is blocked — use sandbox tools instead"; return 1',
      '  fi',
      '  builtin command env "$@"',
      '}',
      '',
      '# Shell functions for blocked commands (catch direct calls)',
      'curl() { _vajra_log "curl" "Use read_file or list_files tools instead"; }',
      'wget() { _vajra_log "wget" "Use read_file or list_files tools instead"; }',
      'git() { _vajra_log "git" "File operations are done through the sandbox tools"; }',
      'ssh() { _vajra_log "ssh" "Network access is restricted in the sandbox"; }',
      'scp() { _vajra_log "scp" "Network access is restricted in the sandbox"; }',
      'rsync() { _vajra_log "rsync" "Network access is restricted in the sandbox"; }',
      'nc() { _vajra_log "nc" "Network access is restricted in the sandbox"; }',
      'ncat() { _vajra_log "ncat" "Network access is restricted in the sandbox"; }',
      'socat() { _vajra_log "socat" "Network access is restricted in the sandbox"; }',
      'python() { _vajra_log "python" "Interpreter access is restricted — use shell builtins"; }',
      'python3() { _vajra_log "python3" "Interpreter access is restricted — use shell builtins"; }',
      'node() { _vajra_log "node" "Interpreter access is restricted — use shell builtins"; }',
      'nodejs() { _vajra_log "nodejs" "Interpreter access is restricted — use shell builtins"; }',
      'ruby() { _vajra_log "ruby" "Interpreter access is restricted — use shell builtins"; }',
      'perl() { _vajra_log "perl" "Interpreter access is restricted — use shell builtins"; }',
      'php() { _vajra_log "php" "Interpreter access is restricted — use shell builtins"; }',
      'lua() { _vajra_log "lua" "Interpreter access is restricted — use shell builtins"; }',
      '',
      '# Block sudo entirely',
      'sudo() { _vajra_log "sudo" "Privilege escalation is not allowed in the sandbox"; }',
      'su() { _vajra_log "su" "Privilege escalation is not allowed in the sandbox"; }',
      '',
      '# Block exit — require token',
      '_vajra_original_exit() { builtin exit "$@"; }',
      'exit() { _vajra_log "exit" "Type _vajra_exit_' + exitToken + ' to leave the sandbox"; }',
      '',
      '# Force all bash sub-invocations through this profile',
      'export BASH_ENV="$VAJRA_PROFILE"',
      '',
      '# Override bash to always use this profile',
      'bash() { builtin bash --rcfile "$VAJRA_PROFILE" --norc=ignore "$@"; }',
      '',
      '# The only way out — requires random token',
      '_vajra_exit_' + exitToken + '() { _vajra_original_exit; }',
      '',
      '# Custom prompt',
      'export PS1="\\[\\033[32m\\]🔒 \\[\\033[0m\\]$ "',
      '',
      '# Welcome message',
      'echo ""',
      'echo "Sandboxed shell — confined to: ' + projectDir + '"',
      'echo "Type _vajra_exit_' + exitToken + ' to leave."',
      'echo ""',
    ].join('\n')

    try {
      writeFileSync(profilePath, profileContent, 'utf-8')
    } catch (e) {
      console.error(`❌ Failed to create shell profile: ${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    }

    // Print the exit token so the user knows how to leave
    console.log(`   Exit token: _vajra_exit_${exitToken}`)
    console.log('')
  }

  // Apply sandbox
  let result
  try {
    result = native.applySandbox({
      projectDir,
      permissions: {
        version: 1,
        default: { read: true, write: false, edit: false, delete: false },
        files: {},
      },
      allowUnenforced: false,
    })
  } catch (e) {
    console.error(`❌ Failed to apply sandbox: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  if (result.enforced) {
    console.log(`🔒 Secured: ${result.mechanism} (enforced)`)
  } else {
    console.log(`⚠️  Secured: ${result.mechanism} (not enforced)`)
  }
  console.log(`   Project: ${projectDir}`)
  console.log('')

  if (needsProfile) {
    // Launch sandboxed shell with sudo exit
    const shell = process.env.SHELL || '/bin/bash'

    try {
      const child = spawnSync(shell, ['--rcfile', profilePath, '-i'], {
        stdio: 'inherit',
        cwd: projectDir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TERM: process.env.TERM,
          VAJRA_PROJECT_DIR: projectDir,
          VAJRA_SANDBOX: '1',
          VAJRA_PROFILE: profilePath,
          BASH_ENV: profilePath,
        },
      })

      // Clean up profile file
      try {
        unlinkSync(profilePath)
      } catch {
        // Ignore cleanup errors
      }

      process.exit(child.status ?? 0)
    } catch (e) {
      // Clean up profile file on error
      try {
        unlinkSync(profilePath)
      } catch {
        // Ignore cleanup errors
      }
      throw e
    }
  }

  // Run the command inside the sandbox
  const [command, ...args] = commandArgs
  try {
    execFileSync(command, args, {
      stdio: 'inherit',
      cwd: projectDir,
    })
  } catch (e: any) {
    process.exit(e.status || 1)
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const command = process.argv[2]

  switch (command) {
    case 'secure':
      cmdSecure()
      break
    case 'status':
      cmdStatus()
      break
    case 'config':
      cmdConfig()
      break
    case 'test':
      cmdTest()
      break
    default:
      console.log(`
Vajra — kernel-level file confinement

Usage:
  vajra <command> [options]

Commands:
  secure   Apply sandbox and run a command (or shell) inside it
  status   Show sandbox capabilities (platform, mechanism, enforcement)
  config   Show or create .vajra-sandbox.json configuration
  test     Test if sandbox works on this platform

Options:
  --project-dir <dir>  Project directory (default: current directory)
  -- <command>         Command to run inside the sandbox (secure only)

Examples:
  vajra secure                            # Sandboxed shell (sudo exit to leave)
  vajra secure -- npm test                # Run tests inside sandbox
  vajra secure -- node server.js          # Run server inside sandbox
  vajra secure --project-dir ./app -- cargo build
  vajra status                            # Check what sandbox is available
  vajra config                            # Create default config
  vajra test                              # Test sandbox on current project

How it works:
  Vajra uses kernel-level sandboxing (Landlock on Linux, Seatbelt on macOS)
  to confine AI coding assistants to a project directory. The sandbox is
  applied when a session starts and is irreversible for that process.

  1. Create a config: vajra config
  2. Edit .vajra-sandbox.json to set permissions
  3. Run your agent: vajra secure -- <agent-command>
`)
      break
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
