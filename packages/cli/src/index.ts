#!/usr/bin/env node

import { Command } from 'commander'
import * as dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import {
  findEnvPath,
  loadEnvIntoProcess,
  parseSetPair,
  readEnvFile,
  resolveApiKeyForModel,
  resolveDefaultModel,
  writeEnvKey,
} from './env.js'
import { runCommand } from './run.js'
import { startTUI } from './tui/index.js'
import { videoCommand } from './video.js'
import {
  deleteSession,
  latestSession,
  listSessions,
  loadMessages,
  loadSession,
  type PersistedSession,
} from './persist/index.js'
import { assessStaleness, describeVerdict } from './session/resume.js'

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** `vajra sessions show` — read-only transcript and plan. */
function printSession(session: PersistedSession, projectDir: string): void {
  console.log(`Session ${session.sessionId}`)
  console.log(`  project   ${session.projectDir}`)
  console.log(`  created   ${new Date(session.createdAt).toISOString()}`)
  console.log(`  updated   ${new Date(session.updatedAt).toISOString()}`)
  console.log(`  phase     ${session.phase}`)
  console.log(`  model     ${session.config.model || '(unset)'}`)
  if (session.git) console.log(`  git       ${session.git.head.slice(0, 8)}${session.git.dirty ? ' (dirty)' : ''}`)

  const tasks = Object.entries(session.tasks ?? {})
  if (tasks.length > 0) {
    console.log('\nTasks:')
    for (const [id, task] of tasks) {
      const detail = task.error ? ` — ${task.error}` : ''
      console.log(`  ${task.status.padEnd(8)} ${id}${detail}`)
    }
  }

  if (session.plan) {
    console.log(`\nPlan (${session.plan.tasks.length} task(s)):`)
    for (const t of session.plan.tasks) {
      console.log(`  ${t.id}: ${t.title}`)
    }
  }

  console.log('\nStaleness:')
  console.log(`  ${describeVerdict(assessStaleness(session, projectDir))}`)

  const messages = loadMessages(session.sessionId, projectDir)
  if (messages.length > 0) {
    console.log(`\nTranscript (${messages.length} message(s)):`)
    for (const m of messages) {
      const body = (m.content ?? '').replace(/\s+/g, ' ').trim()
      if (body) console.log(`  [${m.role}] ${body.slice(0, 200)}`)
    }
  }
}

// Find root .env file (go up from dist/ to packages/cli, then to repo root)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function readPackageVersion(): string {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json')
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const CLI_VERSION = readPackageVersion()
const envPath = findEnvPath()

// Load .env from the discovered path (cwd-first when a local .env exists)
dotenv.config({ path: envPath })
// Also load from current working directory if different
dotenv.config()
// Force-load keys present in the file (dotenv does not override existing vars)
loadEnvIntoProcess()

const program = new Command()

program
  .name('vajra')
  .description('Vajra CLI - Multi-agent task execution from the terminal')
  .version(CLI_VERSION)

program
  .command('run')
  .description('Start an interactive session with the developer agent')
  .argument('[task]', 'Initial task description (optional)')
  .option('-k, --api-key <key>', 'API key (OpenCode Zen)')
  .option('-m, --model <model>', 'LLM model to use', resolveDefaultModel())
  .option('-v, --verbose', 'Show thinking/reasoning output')
  .option('-q, --quiet', 'Suppress tool-level output; show task-level events only')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('-y, --yes', 'Auto-confirm all plans without prompting')
  .option('-t, --timeout <seconds>', 'Per-task timeout in seconds', '300')
  .option('-c, --concurrency <n>', 'Max tasks to run at once', '')
  .option('--allow-unenforced', 'Allow tools to run without OS sandbox enforcement (not recommended)')
  .addHelpText('after', `
Model recommendations (only models with a configured key are offered in the TUI):
  Zen free:      zen/space-bunny-free (default), zen/mimo-v2.6-flash-free, zen/mimo-v2.5-free, …
                 (requires OPENCODE_API_KEY — free tier)
  Go:            go/mimo-v2.5, go/kimi-k3, … (requires OPENCODE_API_KEY)

Only zen/* and go/* model ids are supported.

Examples:
  $ vajra run "fix the login bug"
  $ vajra run -m zen/mimo-v2.5-free "add dark mode"
  $ vajra run -t 600 -y "refactor the database layer"
  $ vajra run --allow-unenforced "continue without OS sandbox enforcement"
  `)
  .action(async (task, options) => {
    const model = options.model as string
    const apiKey = resolveApiKeyForModel(model, options.apiKey as string | undefined)
    await runCommand({
      task,
      apiKey,
      model,
      verbose: options.verbose,
      projectDir: options.dir,
      autoConfirm: options.yes,
      timeout: parseInt(options.timeout, 10) || 300,
      allowUnenforced: Boolean(options.allowUnenforced),
      quiet: Boolean(options.quiet),
      concurrency: parseInt(options.concurrency, 10) || undefined,
    })
  })

program
  .command('sessions')
  .description('List, inspect and remove persisted sessions')
  .argument('[subcommand]', 'show <id> | rm <id>', 'list')
  .argument('[id]', 'Session id for show/rm')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action((subcommand, id, options) => {
    const projectDir = resolve(options.dir)
    const action = String(subcommand ?? 'list')

    if (action === 'list') {
      const sessions = listSessions(projectDir)
      if (sessions.length === 0) {
        console.log(`No sessions recorded for ${projectDir}`)
        return
      }
      console.log('ID                                 PHASE          PROGRESS  AGE      PLAN')
      for (const s of sessions) {
        const age = formatAge(Date.now() - s.updatedAt)
        const progress = `${s.done}/${s.total}`
        console.log(
          `${s.sessionId.padEnd(34)} ${s.phase.padEnd(14)} ${progress.padEnd(9)} ${age.padEnd(8)} ${s.planTitle ?? s.status}`,
        )
      }
      return
    }

    if (action === 'show') {
      if (!id) {
        console.error('Usage: vajra sessions show <id>')
        process.exit(1)
      }
      const session = loadSession(id, projectDir)
      if (!session) {
        console.error(`No session '${id}' in ${projectDir}`)
        process.exit(1)
      }
      printSession(session, projectDir)
      return
    }

    if (action === 'rm') {
      if (!id) {
        console.error('Usage: vajra sessions rm <id>')
        process.exit(1)
      }
      if (!deleteSession(id, projectDir)) {
        console.error(`No session '${id}' in ${projectDir}`)
        process.exit(1)
      }
      console.log(`Removed session ${id}`)
      return
    }

    console.error(`Unknown subcommand '${action}'. Usage: vajra sessions [list|show <id>|rm <id>]`)
    process.exit(1)
  })

program
  .command('resume')
  .description('Resume a persisted session')
  .argument('[id]', 'Session id (defaults to the most recent for this project)')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('-f, --force', 'Resume even when the staleness gate reports a changed tree')
  .option('-k, --api-key <key>', 'API key (OpenCode Zen)')
  .option('-m, --model <model>', 'LLM model to use', resolveDefaultModel())
  .action(async (id, options) => {
    const projectDir = resolve(options.dir)
    const sessionId = id ?? latestSession(projectDir)?.sessionId
    if (!sessionId) {
      console.error(`No sessions recorded for ${projectDir}`)
      process.exit(1)
    }
    const model = options.model
    await runCommand({
      resumeFrom: sessionId,
      force: Boolean(options.force),
      model,
      apiKey: resolveApiKeyForModel(model, options.apiKey),
      verbose: false,
      projectDir,
    })
  })

program
  .command('config')
  .description('Show or set configuration')
  .option('-g, --get <key>', 'Get a config value')
  .option('-s, --set <key=value>', 'Set a config value (e.g. -s FOO=bar)')
  .option('-l, --list', 'List all config values')
  .action((options) => {
    const envPath = findEnvPath()
    const envExists = existsSync(envPath)

    if (options.get) {
      const key = options.get
      const value = process.env[key]
      if (value) {
        console.log(value)
      } else {
        console.error(`Config key '${key}' not found`)
        process.exit(1)
      }
      return
    }

    if (options.set) {
      const parsed = parseSetPair(options.set)
      if (!parsed) {
        console.error(`Invalid --set value '${options.set}'. Usage: vajra config -s KEY=VALUE`)
        process.exit(1)
      }
      const { key, value } = parsed
      if (!value) {
        console.error(`Value is required for key '${key}'. Usage: vajra config -s KEY=VALUE`)
        process.exit(1)
      }

      writeEnvKey(envPath, key, value)
      console.log(`Set ${key}=${key.includes('KEY') ? '***' : value}`)
      return
    }

    // Default: list all config
    console.log('\n\x1b[1mVajra Configuration\x1b[0m\n')

    // Read from .env file directly to show all configured keys
    const knownKeys = [
      'OPENCODE_API_KEY',
      'DEFAULT_MODEL',
      'VAJRA_MODEL',
      'VAJRA_PROJECT_DIR',
    ]

    const envFromFile = readEnvFile(envPath)

    const allKeys = [...new Set([...knownKeys, ...Object.keys(envFromFile)])]

    for (const key of allKeys) {
      const value = process.env[key] || envFromFile[key]
      if (value) {
        const masked = key.includes('KEY') ? value.slice(0, 8) + '...' + value.slice(-4) : value
        console.log(`  \x1b[36m${key}\x1b[0m = ${masked}`)
      } else {
        console.log(`  \x1b[36m${key}\x1b[0m = \x1b[90m(not set)\x1b[0m`)
      }
    }

    console.log('')
    console.log(`  \x1b[36m.env file\x1b[0m = ${envExists ? envPath : '(not found)'}`)
    console.log('')
    console.log('  Usage:')
    console.log('    vajra config              Show all config')
    console.log('    vajra config -g KEY       Get a value')
    console.log('    vajra config -s KEY=VAL   Set a value')
    console.log('')
  })

// Add video command
program.addCommand(videoCommand)

// If no command provided, launch TUI
const args = process.argv.slice(2)
if (args.length === 0) {
  await startTUI(CLI_VERSION)
} else {
  program.parse()
}
