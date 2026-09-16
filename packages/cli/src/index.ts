#!/usr/bin/env node

import { Command } from 'commander'
import * as dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { runCommand } from './run.js'
import { startTUI } from './tui/index.js'

// Find root .env file (go up from dist/ to packages/cli, then to repo root)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '..', '..', '..')

// Load .env from root directory
dotenv.config({ path: resolve(rootDir, '.env') })

// Also load from current working directory if different
dotenv.config()

const program = new Command()

program
  .name('vajra')
  .description('Vajra CLI - Multi-agent task execution from the terminal')
  .version('0.1.0')

program
  .command('run')
  .description('Start an interactive session with the manager agent')
  .argument('[task]', 'Initial task description (optional)')
  .option('-k, --api-key <key>', 'API key (OpenRouter or OpenCode Zen)')
  .option('-m, --model <model>', 'LLM model to use', process.env.VAJRA_MODEL || 'zen/mimo-v2.5-free')
  .option('-v, --verbose', 'Show thinking/reasoning output')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (task, options) => {
    await runCommand({
      task,
      apiKey: options.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENCODE_API_KEY,
      model: options.model,
      verbose: options.verbose,
      projectDir: options.dir,
    })
  })

program
  .command('config')
  .description('Show or set configuration')
  .option('-g, --get <key>', 'Get a config value')
  .option('-s, --set <key> <value>', 'Set a config value')
  .option('-l, --list', 'List all config values')
  .action((options) => {
    const envPath = resolve(rootDir, '.env')
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
      const [key, ...valueParts] = options.set
      const value = valueParts.join(' ')
      
      if (!key) {
        console.error('Key is required')
        process.exit(1)
      }

      let envContent = envExists ? readFileSync(envPath, 'utf-8') : ''
      const regex = new RegExp(`^${key}=.*$`, 'm')
      
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`)
      } else {
        envContent += envContent.endsWith('\n') ? '' : '\n'
        envContent += `${key}=${value}\n`
      }

      writeFileSync(envPath, envContent)
      console.log(`Set ${key}=${value}`)
      return
    }

    // Default: list all config
    console.log('\n\x1b[1mVajra Configuration\x1b[0m\n')
    
    const configKeys = [
      'OPENROUTER_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENCODE_API_KEY',
      'DEFAULT_MODEL',
    ]

    for (const key of configKeys) {
      const value = process.env[key]
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
    console.log('    vajra config -s KEY VAL   Set a value')
    console.log('')
  })

// If no command provided, launch TUI
const args = process.argv.slice(2)
if (args.length === 0) {
  startTUI('0.1.0')
} else {
  program.parse()
}
