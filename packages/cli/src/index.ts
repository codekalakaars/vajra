#!/usr/bin/env node

import { Command } from 'commander'
import * as dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import {
  findEnvPath,
  parseSetPair,
  readEnvFile,
  resolveDefaultModel,
  writeEnvKey,
} from './env.js'
import { runCommand } from './run.js'
import { startTUI } from './tui/index.js'
import { videoCommand } from './video.js'

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

const program = new Command()

program
  .name('vajra')
  .description('Vajra CLI - Multi-agent task execution from the terminal')
  .version(CLI_VERSION)

program
  .command('run')
  .description('Start an interactive session with the developer agent')
  .argument('[task]', 'Initial task description (optional)')
  .option('-k, --api-key <key>', 'API key (OpenRouter or OpenCode Zen)')
  .option('-m, --model <model>', 'LLM model to use', resolveDefaultModel())
  .option('-v, --verbose', 'Show thinking/reasoning output')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('-y, --yes', 'Auto-confirm all plans without prompting')
  .option('-t, --timeout <seconds>', 'Per-task timeout in seconds', '300')
  .addHelpText('after', `
Model recommendations:
  Fast (1-3s):   openai/gpt-4o-mini, openai/gpt-4o, anthropic/claude-3-haiku
  Slow (30-90s): nvidia/*:free, google/*:free (free tier, very slow)
  Zen (blocked):  zen/* (requires OpenCode, not available from CLI)

Examples:
  $ vajra run "fix the login bug"
  $ vajra run -m openai/gpt-4o "add dark mode"
  $ vajra run -t 600 -y "refactor the database layer"
  `)
  .action(async (task, options) => {
    await runCommand({
      task,
      apiKey: options.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENCODE_API_KEY,
      model: options.model,
      verbose: options.verbose,
      projectDir: options.dir,
      autoConfirm: options.yes,
      timeout: parseInt(options.timeout, 10) || 300,
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
      'OPENROUTER_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENCODE_API_KEY',
      'DEFAULT_MODEL',
      'VAJRA_MODEL',
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
