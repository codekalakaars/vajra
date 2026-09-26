#!/usr/bin/env node

import { Command } from 'commander'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { parseSetPair, resolveApiKeyForModel } from './env.js'
import {
  configSource,
  readConfig,
  resolveDefaultDir,
  resolveDefaultModel,
  writeConfig,
} from './config.js'
import { readAuth, writeAuth, clearAuth } from './auth.js'
import { resolveVajraHome, authPath } from './home.js'
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
  if (session.git) console.log(`  git       ${session.git.head.slice(0, 8)} (snapshot${session.git.dirty ? ', dirty' : ''})`)

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
  .option(
    '-d, --dir <directory>',
    'Project directory (defaults to the directory saved in the TUI, else cwd)',
    resolveDefaultDir(),
  )
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
  .option('-d, --dir <directory>', 'Only sessions for this project (default: every project)')
  .action((subcommand, id, options) => {
    const filter = options.dir ? resolve(options.dir) : undefined
    const action = String(subcommand ?? 'list')

    if (action === 'list') {
      const sessions = listSessions(filter)
      if (sessions.length === 0) {
        console.log(filter ? `No sessions recorded for ${filter}` : 'No sessions recorded')
        return
      }
      console.log('ID                                 PHASE          PROGRESS  AGE      PROJECT              PLAN')
      for (const s of sessions) {
        const age = formatAge(Date.now() - s.updatedAt)
        const progress = `${s.done}/${s.total}`
        const cwd = process.cwd()
        const project = s.projectDir.startsWith(`${cwd}/`)
          ? s.projectDir.slice(cwd.length + 1)
          : s.projectDir
        console.log(
          `${s.sessionId.padEnd(34)} ${s.phase.padEnd(14)} ${progress.padEnd(9)} ${age.padEnd(8)} ${project.padEnd(20)} ${s.planTitle ?? s.status}`,
        )
      }
      return
    }

    if (action === 'show') {
      if (!id) {
        console.error('Usage: vajra sessions show <id>')
        process.exit(1)
      }
      const session = loadSession(id)
      if (!session) {
        console.error(`No session '${id}'`)
        process.exit(1)
      }
      printSession(session, session.projectDir)
      return
    }

    if (action === 'rm') {
      if (!id) {
        console.error('Usage: vajra sessions rm <id>')
        process.exit(1)
      }
      if (!deleteSession(id)) {
        console.error(`No session '${id}'`)
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
  .option(
    '-d, --dir <directory>',
    'Project directory (defaults to the directory saved in the TUI, else cwd)',
    resolveDefaultDir(),
  )
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
    // An explicit id is global: resume against the project the session was
    // recorded in, wherever the shell happens to be sitting.
    const stored = loadSession(sessionId)
    if (!stored) {
      console.error(`No session '${sessionId}'`)
      process.exit(1)
    }
    const model = options.model
    await runCommand({
      resumeFrom: sessionId,
      force: Boolean(options.force),
      model,
      apiKey: resolveApiKeyForModel(model, options.apiKey),
      verbose: false,
      projectDir: id ? stored.projectDir : projectDir,
    })
  })

function maskKey(value: string): string {
  if (value.length <= 12) return '***'
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

program
  .command('config')
  .description('Show or set configuration (~/.vajra/config.json)')
  .option('-g, --get <key>', 'Get a config value (model | projectDir)')
  .option('-s, --set <key=value>', 'Set a config value (e.g. -s model=zen/mimo-v2.5-free)')
  .option('-l, --list', 'List all config values with their source')
  .action((options) => {
    const alias: Record<string, 'model' | 'projectDir'> = {
      model: 'model',
      VAJRA_MODEL: 'model',
      projectDir: 'projectDir',
      VAJRA_PROJECT_DIR: 'projectDir',
    }

    if (options.get) {
      const key = alias[options.get]
      if (!key) {
        if (options.get.includes('KEY')) {
          console.error(`Secrets are stored separately. Use: vajra auth status`)
        } else {
          console.error(`Config key '${options.get}' not found (known: model, projectDir)`)
        }
        process.exit(1)
      }
      const value = key === 'model' ? resolveDefaultModel() : resolveDefaultDir()
      console.log(value)
      return
    }

    if (options.set) {
      const parsed = parseSetPair(options.set)
      if (!parsed) {
        console.error(`Invalid --set value '${options.set}'. Usage: vajra config -s model=zen/mimo-v2.5-free`)
        process.exit(1)
      }
      const { key, value } = parsed
      if (!value) {
        console.error(`Value is required for key '${key}'. Usage: vajra config -s model=…`)
        process.exit(1)
      }
      const target = alias[key]
      if (!target) {
        if (key.includes('KEY')) {
          console.error('Secrets do not belong in config.json. Use: vajra auth login <key>')
        } else {
          console.error(`Unknown config key '${key}' (known: model, projectDir)`)
        }
        process.exit(1)
      }

      writeConfig({ [target]: value })
      console.log(`Set ${key}=${value}`)
      console.log(`  → ${resolveVajraHome()}/config.json`)
      return
    }

    // Default: list resolved config with provenance
    const config = readConfig()
    const openCodeKey = process.env.OPENCODE_API_KEY?.trim() || readAuth().OPENCODE_API_KEY

    console.log('\n\x1b[1mVajra Configuration\x1b[0m\n')
    const row = (key: string, value: string, source: string): void => {
      console.log(`  \x1b[36m${key.padEnd(18)}\x1b[0m ${value} \x1b[90m(${source})\x1b[0m`)
    }
    row('model', resolveDefaultModel(), configSource('model'))
    row('projectDir', resolveDefaultDir(), configSource('projectDir'))
    row(
      'OPENCODE_API_KEY',
      openCodeKey ? maskKey(openCodeKey) : '(not set)',
      openCodeKey
        ? process.env.OPENCODE_API_KEY?.trim()
          ? 'env'
          : `auth.json`
        : '-',
    )

    console.log('')
    console.log(`  \x1b[36mvajra home\x1b[0m      = ${resolveVajraHome()}`)
    console.log(`  \x1b[36mconfig file\x1b[0m     = ${resolveVajraHome()}/config.json`)
    console.log('')
    console.log('  Usage:')
    console.log('    vajra config              Show all config (with sources)')
    console.log('    vajra config -g model     Get a value')
    console.log('    vajra config -s model=…   Set a value')
    console.log('    vajra auth login <key>    Store an API key (never in config.json)')
    console.log('')
  })

program
  .command('auth')
  .description('Manage API credentials (~/.vajra/auth.json, mode 0600)')
  .argument('[subcommand]', 'login <key> | status | logout', 'status')
  .argument('[key]', 'API key for login')
  .action((subcommand, key) => {
    const action = String(subcommand ?? 'status')

    if (action === 'login') {
      const apiKey = typeof key === 'string' && key.trim() ? key.trim() : ''
      if (!apiKey) {
        console.error('Usage: vajra auth login <key>')
        process.exit(1)
      }
      const path = writeAuth({ OPENCODE_API_KEY: apiKey })
      console.log(`Stored OPENCODE_API_KEY (${maskKey(apiKey)})`)
      console.log(`  → ${path} (mode 0600)`)
      return
    }

    if (action === 'logout') {
      if (clearAuth()) {
        console.log(`Removed credentials from ${authPath()}`)
        if (process.env.OPENCODE_API_KEY?.trim()) {
          console.log('\x1b[33mNote: OPENCODE_API_KEY is still exported in this shell; unset it there too.\x1b[0m')
        }
      } else {
        console.log('No stored credentials to remove')
      }
      return
    }

    if (action === 'status') {
      const fromEnv = process.env.OPENCODE_API_KEY?.trim()
      const stored = readAuth().OPENCODE_API_KEY
      const source = fromEnv ? 'env' : stored ? 'auth.json' : null
      if (!source) {
        console.log('Not logged in')
        console.log('  Set one with: vajra auth login <key>')
        process.exit(1)
      }
      console.log(`OPENCODE_API_KEY ${maskKey(fromEnv ?? stored ?? '')} (from ${source})`)
      console.log(`  auth file: ${authPath()}`)
      return
    }

    console.error(`Unknown subcommand '${action}'. Usage: vajra auth [login <key>|status|logout]`)
    process.exit(1)
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
